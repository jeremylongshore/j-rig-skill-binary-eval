/**
 * Eval budgets — a spend and latency cap for one `j-rig eval` invocation.
 *
 * Four limits, each optional: `max_usd`, `max_tokens`, `max_wall_ms`,
 * `max_calls`. A spec may declare them (`budget:`), the operator may pass
 * them (`--max-usd` …); when both set a limit the stricter one wins. The
 * budget spans the whole invocation: every model in `--models`, every phase.
 *
 * Enforcement is a pre-call guard. Each metered provider call (and each
 * claude-code case) first asks the budget whether anything is spent; once a
 * limit is reached the guard throws {@link BudgetExceededError} instead of
 * calling, and the budget latches a {@link BudgetStop} naming the limit, the
 * observed value, the phase and the model. Usage is only known after a call
 * returns, so a run can overshoot a limit by at most the calls already in
 * flight when it was reached (one, or one criterion's concurrent judge
 * samples). The eval command checks the latch at phase boundaries and stops
 * cleanly: no verdict, no Evidence Bundle row, the stop recorded on the run.
 *
 * `max_usd` counts the API-equivalent estimate, including subscription-local
 * claude-code usage that is not billed, and fails CLOSED when a model has no
 * rate on file: a dollar cap that cannot price the spend cannot honor itself.
 * Limits are checked in a fixed order (usd, tokens, calls, wall time), so
 * while a model is unpriced a set `max_usd` latches first and the other
 * limits never get the chance: pair `max_usd` only with priced models.
 */

import type {
  CompletionRequest,
  CompletionResult,
  ExecutionContext,
  ExecutionMeta,
  ExecutionOutput,
  ExecutionProvider,
  Provider,
  ProviderError,
  StreamChunk,
  ToolCallResult,
  ToolDefinition,
} from "@j-rig/core";
import type { EvalCostMeter, EvalCostReport, EvalPhase } from "./cost-tracking.js";

export const BUDGET_LIMIT_NAMES = ["max_usd", "max_tokens", "max_wall_ms", "max_calls"] as const;
export type BudgetLimitName = (typeof BUDGET_LIMIT_NAMES)[number];
export type EvalBudgetLimits = Partial<Record<BudgetLimitName, number>>;

/** Why a run stopped. Latched once; never overwritten. */
export interface BudgetStop {
  limit: BudgetLimitName;
  max: number;
  /** The spent value that reached the limit; null when USD could not be priced. */
  observed: number | null;
  /** Where the limit's value came from. */
  source: "spec" | "run";
  phase: EvalPhase;
  model: string;
  /** Milliseconds since the budget started. */
  elapsed_ms: number;
  reason: string;
}

export interface BudgetSpent {
  /** API-equivalent USD; null when any recorded model has no rate on file. */
  usd: number | null;
  tokens: number;
  calls: number;
  wall_ms: number;
}

export interface BudgetSummary {
  limits: EvalBudgetLimits;
  sources: Partial<Record<BudgetLimitName, "spec" | "run">>;
  spent: BudgetSpent;
  stop: BudgetStop | null;
}

/** Combine the spec's and the run's limits: per limit, the stricter (smaller) value wins. */
export function mergeBudgetLimits(
  spec: EvalBudgetLimits | undefined,
  run: EvalBudgetLimits | undefined,
): { limits: EvalBudgetLimits; sources: BudgetSummary["sources"] } {
  const limits: EvalBudgetLimits = {};
  const sources: BudgetSummary["sources"] = {};
  for (const name of BUDGET_LIMIT_NAMES) {
    const s = spec?.[name];
    const r = run?.[name];
    if (s === undefined && r === undefined) continue;
    if (r !== undefined && (s === undefined || r < s)) {
      limits[name] = r;
      sources[name] = "run";
    } else {
      limits[name] = s!;
      sources[name] = "spec";
    }
  }
  return { limits, sources };
}

/** Thrown by a guard instead of making a call once the budget is spent. */
export class BudgetExceededError extends Error {
  readonly stop: BudgetStop;
  constructor(stop: BudgetStop) {
    super(`eval budget exhausted: ${stop.reason}`);
    this.name = "BudgetExceededError";
    this.stop = stop;
  }
}

function sumUsd(reports: EvalCostReport[]): { usd: number | null; unpriced?: string } {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const r of reports) {
    for (const m of r.by_model) if (m.usd === null) unpriced.add(m.model);
    if (r.estimated_usd !== null) usd += r.estimated_usd;
  }
  // Name every unpriced model so the operator can fix the rate table in one pass.
  return unpriced.size > 0 ? { usd: null, unpriced: [...unpriced].join(", ") } : { usd };
}

const fmtUsd = (v: number) => `$${v.toFixed(4)}`;

export class RunBudget {
  readonly limits: EvalBudgetLimits;
  readonly sources: BudgetSummary["sources"];
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #closed: EvalCostReport[] = [];
  #current: { meter: EvalCostMeter; model: string } | null = null;
  #stop: BudgetStop | null = null;

  constructor(
    limits: EvalBudgetLimits,
    sources: BudgetSummary["sources"] = {},
    now: () => number = Date.now,
  ) {
    this.limits = limits;
    this.sources = sources;
    this.#now = now;
    this.#startedAt = now();
  }

  /** True when at least one limit is set. */
  get active(): boolean {
    return BUDGET_LIMIT_NAMES.some((n) => this.limits[n] !== undefined);
  }

  get stop(): BudgetStop | null {
    return this.#stop;
  }

  /** Start metering a new model; the previous model's spend is kept. */
  attach(meter: EvalCostMeter, model: string): void {
    if (this.#current) this.#closed.push(this.#current.meter.report());
    this.#current = { meter, model };
  }

  spent(): BudgetSpent & { unpriced?: string } {
    const reports = [...this.#closed, ...(this.#current ? [this.#current.meter.report()] : [])];
    const { usd, unpriced } = sumUsd(reports);
    return {
      usd,
      ...(unpriced ? { unpriced } : {}),
      tokens: reports.reduce((n, r) => n + r.total.input_tokens + r.total.output_tokens, 0),
      calls: reports.reduce((n, r) => n + r.total.calls, 0),
      wall_ms: this.#now() - this.#startedAt,
    };
  }

  /**
   * Is the budget spent? Latches and returns the stop on the first limit
   * reached (limits checked in a fixed order); null while within budget.
   */
  check(): BudgetStop | null {
    if (this.#stop || !this.active) return this.#stop;
    const s = this.spent();
    const phase = this.#current?.meter.phase ?? "trigger";
    const model = this.#current?.model ?? "";
    const stop = (limit: BudgetLimitName, observed: number | null, reason: string): BudgetStop => ({
      limit,
      max: this.limits[limit]!,
      observed,
      source: this.sources[limit] ?? "run",
      phase,
      model,
      elapsed_ms: s.wall_ms,
      reason,
    });

    const { max_usd, max_tokens, max_wall_ms, max_calls } = this.limits;
    let hit: BudgetStop | null = null;
    if (max_usd !== undefined && s.usd === null) {
      hit = stop(
        "max_usd",
        null,
        `max_usd ${fmtUsd(max_usd)} cannot be enforced: no rate on file for ${s.unpriced ?? "a model"}`,
      );
    } else if (max_usd !== undefined && s.usd !== null && s.usd >= max_usd) {
      hit = stop(
        "max_usd",
        s.usd,
        `spent ${fmtUsd(s.usd)} (API-equivalent) of max_usd ${fmtUsd(max_usd)}`,
      );
    } else if (max_tokens !== undefined && s.tokens >= max_tokens) {
      hit = stop("max_tokens", s.tokens, `spent ${s.tokens} tokens of max_tokens ${max_tokens}`);
    } else if (max_calls !== undefined && s.calls >= max_calls) {
      hit = stop("max_calls", s.calls, `made ${s.calls} calls of max_calls ${max_calls}`);
    } else if (max_wall_ms !== undefined && s.wall_ms >= max_wall_ms) {
      hit = stop("max_wall_ms", s.wall_ms, `ran ${s.wall_ms} ms of max_wall_ms ${max_wall_ms}`);
    }
    if (hit) this.#stop = hit;
    return this.#stop;
  }

  /** Guard: throw instead of calling once the budget is spent. */
  assertWithin(): void {
    const stop = this.check();
    if (stop) throw new BudgetExceededError(stop);
  }

  summary(): BudgetSummary {
    const s = this.spent();
    const spent: BudgetSpent = { usd: s.usd, tokens: s.tokens, calls: s.calls, wall_ms: s.wall_ms };
    return { limits: { ...this.limits }, sources: { ...this.sources }, spent, stop: this.#stop };
  }
}

/**
 * Pre-call budget guard around any real `Provider`. Wraps OUTSIDE the cost
 * meter so a refused call is never recorded as spend.
 */
export class BudgetGuardedProvider implements Provider {
  readonly #inner: Provider;
  readonly #budget: RunBudget;

  constructor(inner: Provider, budget: RunBudget) {
    this.#inner = inner;
    this.#budget = budget;
  }

  get name(): string {
    return this.#inner.name;
  }

  get version(): string {
    return this.#inner.version;
  }

  // async so a refusal is always a rejected promise, never a synchronous throw.
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.#budget.assertWithin();
    return this.#inner.complete(req);
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    this.#budget.assertWithin();
    yield* this.#inner.completeStream(req);
  }

  async callTool(req: CompletionRequest & { tools: ToolDefinition[] }): Promise<ToolCallResult> {
    this.#budget.assertWithin();
    return this.#inner.callTool(req);
  }

  async batch(reqs: CompletionRequest[]): Promise<Array<CompletionResult | ProviderError>> {
    this.#budget.assertWithin();
    return this.#inner.batch(reqs);
  }
}

/** The same pre-call guard for an execution provider that is not a `Provider` (claude-code). */
export class BudgetGuardedExecutionProvider implements ExecutionProvider {
  readonly #inner: ExecutionProvider;
  readonly #budget: RunBudget;

  constructor(inner: ExecutionProvider, budget: RunBudget) {
    this.#inner = inner;
    this.#budget = budget;
  }

  async execute(
    prompt: string,
    context: ExecutionContext,
    options?: Parameters<ExecutionProvider["execute"]>[2],
  ): Promise<ExecutionOutput & { meta: ExecutionMeta }> {
    this.#budget.assertWithin();
    return this.#inner.execute(prompt, context, options);
  }
}
