/**
 * Eval cost tracking — answers "what does it cost to eval this skill, as-is?"
 *
 * A transparent `Provider` decorator records the REAL token usage every
 * adapter already returns (`CompletionResult.usage` / `ToolCallResult.usage`)
 * and attributes it to the eval phase that spent it (trigger / execution /
 * judge). The eval command flips {@link EvalCostMeter.phase} at each phase
 * boundary — phases run strictly sequentially per model, so a mutable marker
 * is sufficient and no request-tagging is needed.
 *
 * Why this matters: multi-sample majority judging (N samples per judge
 * criterion) multiplies JUDGE cost by N. The pay-vs-free judge decision has to
 * be a number, not a vibe — this meter is that number's source, and it doubles
 * as the data feed for the OTel cost-join (judge span cost attributes).
 *
 * USD estimation is best-effort from a small static rate table; an unknown
 * model reports `estimated_usd: null` rather than a fabricated figure.
 */

import type {
  CompletionRequest,
  CostPhaseNameValue,
  CompletionResult,
  Provider,
  ProviderError,
  StreamChunk,
  TokenUsage,
  ToolCallResult,
  ToolDefinition,
} from "@j-rig/core";

/** The three sequential phases of a per-model eval run. */
// Tied to the core cost.* vocabulary so the two cannot silently drift: a
// fourth phase added in one place is a type error in the other, not a
// phase whose cost lands in the run total with no phase event.
export type EvalPhase = CostPhaseNameValue;

export interface PhaseCost {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/** Per-run cost report — attached to the run result and printed after scoring. */
export interface EvalCostReport {
  phases: Record<EvalPhase, PhaseCost>;
  total: PhaseCost;
  /**
   * Best-effort USD estimate across all recorded calls, summed per-model from
   * the rate table. Null when ANY recorded model has no rate on file (a
   * partial estimate would understate real cost — fail honest, not cheap).
   * Includes API-equivalent cost of not-billed usage (see `billed_usd`).
   */
  estimated_usd: number | null;
  /**
   * The part of `estimated_usd` that is actually billed per token. Excludes
   * subscription-local `claude-code/*` execution, which is reported at the
   * API-equivalent list rate but not billed. Null when `estimated_usd` is.
   */
  billed_usd: number | null;
  /** Per-model breakdown: tokens and the rate used (null rate = unknown). */
  by_model: Array<{
    model: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    /** Input tokens the provider reported as cache reads (a subset of input_tokens). */
    cached_input_tokens: number;
    usd: number | null;
    /** False for subscription-local runs: `usd` is an API-equivalent figure, not a bill. */
    billed: boolean;
    /** Rate-table key the USD was priced from, or null when unpriced. */
    rate_key: string | null;
    /** Why the figure is or is not billed / priced, when that needs saying. */
    note?: string;
  }>;
}

/** One rate-table row: USD per million tokens. */
export interface ModelRate {
  input: number;
  output: number;
  /** Cache-read input rate; omitted = cache reads priced at `input`. */
  cached_input?: number;
  note?: string;
}

/**
 * USD per MILLION tokens (input, output, cache-read input), keyed by vendor
 * model id. Free-tier endpoints are listed at 0 with a note — "free" is a real
 * price point in the judge value benchmark, not missing data.
 *
 * Rates move; this table is advisory and additive. Unknown model → null USD.
 * Every row names its source and the date it was read; refresh both together.
 */
export const MODEL_RATES_USD_PER_MTOK: Record<string, ModelRate> = {
  // DeepSeek (paid)
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek-chat": { input: 0.14, output: 0.28, note: "legacy alias of v4-flash" },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  // Groq free tier (30 rpm cap)
  "llama-3.3-70b-versatile": { input: 0, output: 0, note: "Groq free tier (retired)" },
  "openai/gpt-oss-120b": { input: 0, output: 0, note: "Groq free tier" },
  // NVIDIA NIM free tier
  "meta/llama-3.3-70b-instruct": { input: 0, output: 0, note: "NVIDIA NIM free tier (retired)" },
  "openai/gpt-oss-20b": { input: 0, output: 0, note: "NVIDIA NIM free tier" },
  "meta/llama-3.1-405b-instruct": { input: 0, output: 0, note: "NVIDIA NIM free tier" },
  // MiniMax pay-as-you-go list prices, Standard tier.
  // Source: https://platform.minimax.io/docs/guides/pricing-paygo (read 2026-10-08).
  // MiniMax-M3 is tiered by prompt size; this is the <= 512k-input row (the
  // > 512k row is 2x). The estate's MiniMax keys are a Coding Plan
  // subscription, so these are list-price equivalents, not the invoice.
  "MiniMax-M3": {
    input: 0.3,
    output: 1.2,
    cached_input: 0.06,
    note: "MiniMax list, <= 512k input (> 512k is 2x)",
  },
  "MiniMax-M2.7": { input: 0.3, output: 1.2, cached_input: 0.06, note: "MiniMax list" },
  "MiniMax-M2.7-highspeed": { input: 0.6, output: 2.4, cached_input: 0.06, note: "MiniMax list" },
  // Anthropic first-party API list prices.
  // Source: Anthropic claude-api reference, Current Models + prompt-caching
  // economics (pricing table cached 2026-09-25, read 2026-10-08). Cache reads:
  // Fable 5.1 $0.25, Opus 5.5 / Sonnet 5.5 $0.20, Haiku 4.5 0.1x input.
  // Cache WRITES (1.25x) are not separately metered and price at `input`.
  "claude-fable-5-1": { input: 10, output: 50, cached_input: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cached_input: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cached_input: 0.2 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cached_input: 0.1 },
  "claude-haiku-4-5": { input: 1, output: 5, cached_input: 0.1, note: "alias of 20251001" },
};

/**
 * Prefix the claude-code execution provider puts on the model it reports
 * (`claude-code/<model>`). Those calls run on the local Claude Code
 * subscription: priced at the base model's API rate, reported as not billed.
 */
export const SUBSCRIPTION_MODEL_PREFIX = "claude-code/";

export interface RateLookup {
  rate: ModelRate;
  /** The table key that matched. */
  key: string;
  /** False for subscription-local usage. */
  billed: boolean;
}

/**
 * Resolve a recorded model id to its rate: exact key, then case-insensitive
 * (vendors echo ids with varying case), after stripping the subscription
 * prefix. Unknown → null: never guess a price.
 */
export function lookupModelRate(model: string): RateLookup | null {
  const billed = !model.startsWith(SUBSCRIPTION_MODEL_PREFIX);
  const id = billed ? model : model.slice(SUBSCRIPTION_MODEL_PREFIX.length);
  const exact = MODEL_RATES_USD_PER_MTOK[id];
  if (exact) return { rate: exact, key: id, billed };
  const lower = id.toLowerCase();
  const key = Object.keys(MODEL_RATES_USD_PER_MTOK).find((k) => k.toLowerCase() === lower);
  return key ? { rate: MODEL_RATES_USD_PER_MTOK[key]!, key, billed } : null;
}

/**
 * USD for one model's usage. Cache reads are a subset of input tokens (every
 * adapter normalizes to that convention) and are priced at the cache-read
 * rate when the row has one. The clamp only guards a malformed report.
 */
export function priceUsage(
  rate: ModelRate,
  usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number },
): number {
  const cached = Math.min(usage.cached_input_tokens, usage.input_tokens);
  const cachedRate = rate.cached_input ?? rate.input;
  return (
    ((usage.input_tokens - cached) * rate.input +
      cached * cachedRate +
      usage.output_tokens * rate.output) /
    1_000_000
  );
}

function emptyPhase(): PhaseCost {
  return { calls: 0, input_tokens: 0, output_tokens: 0 };
}

/**
 * Stateful accumulator for one per-model eval run. The eval command sets
 * `phase` at each boundary; the {@link CostTrackingProvider} records into
 * whichever phase is current.
 */
export class EvalCostMeter {
  phase: EvalPhase = "trigger";
  readonly #phases: Record<EvalPhase, PhaseCost> = {
    trigger: emptyPhase(),
    execution: emptyPhase(),
    judge: emptyPhase(),
  };
  readonly #byModel = new Map<string, PhaseCost>();
  readonly #cachedByModel = new Map<string, number>();

  record(model: string, usage: TokenUsage): void {
    // Defensive: a misbehaving adapter may omit usage or its fields — never
    // let NaN propagate into the report (a wrong number is worse than none).
    if (!usage) return;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;

    const p = this.#phases[this.phase];
    p.calls++;
    p.input_tokens += input;
    p.output_tokens += output;

    const m = this.#byModel.get(model) ?? emptyPhase();
    m.calls++;
    m.input_tokens += input;
    m.output_tokens += output;
    this.#byModel.set(model, m);
    const cached = usage.cachedInputTokens ?? 0;
    if (cached > 0) this.#cachedByModel.set(model, (this.#cachedByModel.get(model) ?? 0) + cached);
  }

  report(): EvalCostReport {
    const total = emptyPhase();
    for (const p of Object.values(this.#phases)) {
      total.calls += p.calls;
      total.input_tokens += p.input_tokens;
      total.output_tokens += p.output_tokens;
    }

    let estimatedUsd: number | null = 0;
    let billedUsd: number | null = 0;
    const byModel: EvalCostReport["by_model"] = [];
    for (const [model, m] of this.#byModel) {
      const cached_input_tokens = this.#cachedByModel.get(model) ?? 0;
      const hit = lookupModelRate(model);
      const billed = !model.startsWith(SUBSCRIPTION_MODEL_PREFIX);
      const usd = hit ? priceUsage(hit.rate, { ...m, cached_input_tokens }) : null;
      // Keep the row's own caveat (e.g. a tiered price) beside the billing label.
      const note = !billed
        ? ["API-equivalent at list rate; Claude Code subscription run, not billed", hit?.rate.note]
            .filter(Boolean)
            .join("; ")
        : hit?.rate.note;
      byModel.push({
        model,
        ...m,
        cached_input_tokens,
        usd,
        billed,
        rate_key: hit?.key ?? null,
        ...(note ? { note } : {}),
      });
      if (usd === null) {
        estimatedUsd = null;
        billedUsd = null;
      } else {
        if (estimatedUsd !== null) estimatedUsd += usd;
        if (billedUsd !== null && billed) billedUsd += usd;
      }
    }

    return {
      phases: {
        trigger: { ...this.#phases.trigger },
        execution: { ...this.#phases.execution },
        judge: { ...this.#phases.judge },
      },
      total,
      estimated_usd: estimatedUsd,
      billed_usd: billedUsd,
      by_model: byModel,
    };
  }
}

/**
 * Transparent cost-recording decorator around any real `Provider`. Delegates
 * every call unchanged; records usage from each result. Streaming usage is
 * recorded from the terminal `finish` chunk when the adapter reports it.
 * Batch errors carry no usage and are skipped (in-band `ProviderError`
 * elements per the Provider contract).
 */
export class CostTrackingProvider implements Provider {
  readonly #inner: Provider;
  readonly #meter: EvalCostMeter;

  constructor(inner: Provider, meter: EvalCostMeter) {
    this.#inner = inner;
    this.#meter = meter;
  }

  get name(): string {
    return this.#inner.name;
  }

  get version(): string {
    return this.#inner.version;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await this.#inner.complete(req);
    this.#meter.record(res.model, res.usage);
    return res;
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    for await (const chunk of this.#inner.completeStream(req)) {
      if (chunk.type === "finish" && chunk.usage) {
        this.#meter.record(req.model, chunk.usage);
      }
      yield chunk;
    }
  }

  async callTool(req: CompletionRequest & { tools: ToolDefinition[] }): Promise<ToolCallResult> {
    const res = await this.#inner.callTool(req);
    this.#meter.record(req.model, res.usage);
    return res;
  }

  async batch(reqs: CompletionRequest[]): Promise<Array<CompletionResult | ProviderError>> {
    const results = await this.#inner.batch(reqs);
    for (const r of results) {
      // `in` throws on null/undefined — guard the object shape before probing.
      if (r && typeof r === "object" && !(r instanceof Error) && "usage" in r) {
        this.#meter.record(r.model, r.usage);
      }
    }
    return results;
  }
}
