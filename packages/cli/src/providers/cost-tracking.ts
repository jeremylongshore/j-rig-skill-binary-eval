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
  CompletionResult,
  Provider,
  ProviderError,
  StreamChunk,
  TokenUsage,
  ToolCallResult,
  ToolDefinition,
} from "@j-rig/core";

/** The three sequential phases of a per-model eval run. */
export type EvalPhase = "trigger" | "execution" | "judge";

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
   */
  estimated_usd: number | null;
  /** Per-model breakdown: tokens and the rate used (null rate = unknown). */
  by_model: Array<{
    model: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    usd: number | null;
  }>;
}

/**
 * USD per MILLION tokens (input, output), keyed by vendor model id.
 * Free-tier endpoints are listed at 0 with a note — "free" is a real price
 * point in the judge value benchmark, not missing data.
 *
 * Rates move; this table is advisory and additive. Unknown model → null USD.
 */
export const MODEL_RATES_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; note?: string }
> = {
  // DeepSeek (paid)
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek-chat": { input: 0.14, output: 0.28, note: "legacy alias of v4-flash" },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  // Groq free tier (30 rpm cap)
  "llama-3.3-70b-versatile": { input: 0, output: 0, note: "Groq free tier" },
  // NVIDIA NIM free tier
  "meta/llama-3.3-70b-instruct": { input: 0, output: 0, note: "NVIDIA NIM free tier" },
  "meta/llama-3.1-405b-instruct": { input: 0, output: 0, note: "NVIDIA NIM free tier" },
};

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
  }

  report(): EvalCostReport {
    const total = emptyPhase();
    for (const p of Object.values(this.#phases)) {
      total.calls += p.calls;
      total.input_tokens += p.input_tokens;
      total.output_tokens += p.output_tokens;
    }

    let estimatedUsd: number | null = 0;
    const byModel: EvalCostReport["by_model"] = [];
    for (const [model, m] of this.#byModel) {
      const rate = MODEL_RATES_USD_PER_MTOK[model];
      const usd = rate
        ? (m.input_tokens * rate.input + m.output_tokens * rate.output) / 1_000_000
        : null;
      byModel.push({ model, ...m, usd });
      if (usd === null) estimatedUsd = null;
      else if (estimatedUsd !== null) estimatedUsd += usd;
    }

    return {
      phases: {
        trigger: { ...this.#phases.trigger },
        execution: { ...this.#phases.execution },
        judge: { ...this.#phases.judge },
      },
      total,
      estimated_usd: estimatedUsd,
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
