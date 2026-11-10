import {
  EvaluationTokenUsageSchema,
  type EvaluationCall,
  type EvaluationUsageEvidence,
} from "@intentsolutions/refiner-core";
/**
 * Eval cost tracking — answers "what does it cost to eval this skill, as-is?"
 *
 * A `Provider` decorator preserves reported token usage and keeps failed or
 * unmeasured calls explicit (`CompletionResult.usage` / `ToolCallResult.usage`)
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
  /** Counts are known subtotals; unknown_calls makes incompleteness explicit. */
  unknown_calls: number;
  usage_complete: boolean;
  usage_evidence: EvaluationUsageEvidence;
  phases: Record<EvalPhase, PhaseCost>;
  total: PhaseCost;
  /**
   * Best-effort USD estimate across all recorded calls, summed per-model from
   * the rate table. Null for unknown usage, unpriced models or cache writes.
   * A partial estimate would understate cost. This is not an invoice.
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
  // Cache writes have no rates here; measured writes make USD unknown.
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
  const exact = Object.hasOwn(MODEL_RATES_USD_PER_MTOK, id)
    ? MODEL_RATES_USD_PER_MTOK[id]
    : undefined;
  if (exact) return { rate: exact, key: id, billed };
  const lower = id.toLowerCase();
  const key = Object.keys(MODEL_RATES_USD_PER_MTOK).find((k) => k.toLowerCase() === lower);
  return key ? { rate: MODEL_RATES_USD_PER_MTOK[key]!, key, billed } : null;
}

/**
 * USD for one model's usage. Cache reads are a subset of input tokens (every
 * adapter normalizes to that convention) and are priced at the cache-read
 * rate when the row has one. Invalid counts and unpriced cache writes yield null.
 */
export function priceUsage(
  rate: ModelRate,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cache_creation_input_tokens?: number;
  },
): number | null {
  const parsed = EvaluationTokenUsageSchema.safeParse({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
  });
  if (
    !parsed.success ||
    [rate.input, rate.output, rate.cached_input ?? rate.input].some(
      (n) => !Number.isFinite(n) || n < 0,
    )
  )
    return null;
  // The advisory table has no cache-write/TTL rates. Do not underprice writes.
  if ((usage.cache_creation_input_tokens ?? 0) > 0) return null;
  const cached = usage.cached_input_tokens;
  const result =
    ((usage.input_tokens - cached) * rate.input +
      cached * (rate.cached_input ?? rate.input) +
      usage.output_tokens * rate.output) /
    1_000_000;
  return Number.isFinite(result) ? result : null;
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
  #phase: EvalPhase = "trigger";
  get phase(): EvalPhase {
    return this.#phase;
  }
  set phase(value: EvalPhase) {
    if (!["trigger", "execution", "judge"].includes(value)) throw new Error("Invalid cost phase");
    this.#phase = value;
  }
  readonly #calls: EvaluationCall[] = [];
  readonly #settled = new Set<number>();

  get pendingCalls(): number {
    return this.#calls.length - this.#settled.size;
  }
  #input = 0;
  #output = 0;

  /** Register before I/O so interrupted/in-flight calls cannot disappear. */
  begin(model: string, provider = "external"): number {
    if (
      typeof model !== "string" ||
      !model.trim() ||
      typeof provider !== "string" ||
      !provider.trim()
    )
      throw new Error("Missing cost call identity");
    const sequence = this.#calls.length;
    this.#calls.push({
      sequence,
      phase: this.phase,
      provider,
      requestedModel: model,
      reportedModel: null,
      outcome: "interrupted",
      usage: null,
    });
    return sequence;
  }

  finish(
    sequence: number,
    usage: TokenUsage | null | undefined,
    outcome: EvaluationCall["outcome"] = "completed",
    reportedModel?: string,
  ): void {
    const call = this.#calls[sequence];
    if (!call || this.#settled.has(sequence)) throw new Error("Unknown or settled cost call");
    this.#settled.add(sequence);
    const parsed = EvaluationTokenUsageSchema.safeParse(usage);
    let measured = parsed.success ? parsed.data : null;
    if (
      measured &&
      !Number.isSafeInteger(
        this.#input + this.#output + measured.inputTokens + measured.outputTokens,
      )
    )
      measured = null;
    if (measured) {
      this.#input += measured.inputTokens;
      this.#output += measured.outputTokens;
    }
    this.#calls[sequence] = {
      ...call,
      outcome,
      usage: measured,
      reportedModel:
        typeof reportedModel === "string" && reportedModel.trim() ? reportedModel : null,
    };
  }

  record(model: string, usage: TokenUsage | null | undefined): void {
    this.finish(this.begin(model), usage);
  }

  report(opts: { settledOnly?: boolean } = {}): EvalCostReport {
    const calls = this.#calls.filter(
      (call) => !opts.settledOnly || this.#settled.has(call.sequence),
    );
    const phases: Record<EvalPhase, PhaseCost> = {
      trigger: emptyPhase(),
      execution: emptyPhase(),
      judge: emptyPhase(),
    };
    const total = emptyPhase();
    const models = new Map<
      string,
      PhaseCost & {
        cached_input_tokens: number;
        cache_creation_input_tokens: number;
        unknown: boolean;
      }
    >();
    let unknown = 0;
    for (const call of calls) {
      const identity = call.reportedModel ?? call.requestedModel;
      // Keep wire model identity in the evidence; the legacy report key carries
      // subscription billing classification separately from that identity.
      const model =
        call.provider === "claude-code" ? SUBSCRIPTION_MODEL_PREFIX + identity : identity;
      const row = models.get(model) ?? {
        ...emptyPhase(),
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        unknown: false,
      };
      row.calls++;
      total.calls++;
      phases[call.phase].calls++;
      if (!call.usage) {
        unknown++;
        row.unknown = true;
      } else {
        const {
          inputTokens,
          outputTokens,
          cachedInputTokens = 0,
          cacheCreationInputTokens = 0,
        } = call.usage;
        for (const target of [row, total, phases[call.phase]]) {
          target.input_tokens += inputTokens;
          target.output_tokens += outputTokens;
        }
        row.cached_input_tokens += cachedInputTokens;
        row.cache_creation_input_tokens += cacheCreationInputTokens;
      }
      models.set(model, row);
    }
    let estimatedUsd: number | null = 0;
    let billedUsd: number | null = 0;
    const byModel: EvalCostReport["by_model"] = [];
    for (const [model, row] of models) {
      const hit = lookupModelRate(model);
      const billed = !model.startsWith(SUBSCRIPTION_MODEL_PREFIX);
      const usd = hit && !row.unknown ? priceUsage(hit.rate, row) : null;
      const note = !billed
        ? ["API-equivalent at list rate; Claude Code subscription run, not billed", hit?.rate.note]
            .filter(Boolean)
            .join("; ")
        : hit?.rate.note;
      byModel.push({
        model,
        calls: row.calls,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cached_input_tokens: row.cached_input_tokens,
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
    if (estimatedUsd !== null && !Number.isFinite(estimatedUsd)) {
      estimatedUsd = null;
      billedUsd = null;
    }
    return {
      phases,
      total,
      by_model: byModel,
      estimated_usd: estimatedUsd,
      billed_usd: billedUsd,
      unknown_calls: unknown,
      usage_complete: unknown === 0,
      usage_evidence: {
        schema: "evaluation-usage/v1",
        calls: structuredClone(calls).map((call, sequence) => ({ ...call, sequence })),
      },
    };
  }
}

/** Every attempted call counts, including failures, missing usage and interrupted streams. */
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
    const call = this.#meter.begin(req.model, this.name);
    let result: CompletionResult;
    try {
      result = await this.#inner.complete(req);
    } catch (error) {
      this.#meter.finish(call, null, "failed");
      throw error;
    }
    this.#meter.finish(call, result.usage, "completed", result.reportedModel);
    return result;
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const call = this.#meter.begin(req.model, this.name);
    let usage: TokenUsage | null | undefined;
    let reportedModel: string | undefined;
    let outcome: EvaluationCall["outcome"] = "interrupted";
    let seenFinish = false;
    try {
      for await (const chunk of this.#inner.completeStream(req)) {
        if (chunk.type === "finish") {
          if (seenFinish) {
            usage = null;
            throw new Error("Duplicate completion usage frame");
          }
          seenFinish = true;
          usage = chunk.usage;
          reportedModel = chunk.reportedModel;
          outcome = "completed";
        }
        yield chunk;
      }
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      this.#meter.finish(call, usage, outcome, reportedModel);
    }
  }

  async callTool(req: CompletionRequest & { tools: ToolDefinition[] }): Promise<ToolCallResult> {
    const call = this.#meter.begin(req.model, this.name);
    let result: ToolCallResult;
    try {
      result = await this.#inner.callTool(req);
    } catch (error) {
      this.#meter.finish(call, null, "failed");
      throw error;
    }
    this.#meter.finish(call, result.usage, "completed", result.reportedModel);
    return result;
  }

  async batch(reqs: CompletionRequest[]): Promise<Array<CompletionResult | ProviderError>> {
    const calls = reqs.map((req) => this.#meter.begin(req.model, this.name));
    let results: Array<CompletionResult | ProviderError>;
    try {
      results = await this.#inner.batch(reqs);
    } catch (error) {
      for (const call of calls) this.#meter.finish(call, null, "failed");
      throw error;
    }
    for (let i = 0; i < Math.max(calls.length, results.length); i++) {
      const result = results[i];
      const call = calls[i] ?? this.#meter.begin("unattributed-batch-result", this.name);
      if (result && typeof result === "object" && !(result instanceof Error) && "usage" in result)
        this.#meter.finish(call, result.usage, "completed", result.reportedModel);
      else this.#meter.finish(call, null, "failed");
    }
    return results;
  }
}
