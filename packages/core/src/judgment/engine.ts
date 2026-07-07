import type { Criterion } from "../schemas/criterion.js";
import type { ObservedOutcome } from "../execution/types.js";
import { runCheck } from "../checks/deterministic-registry.js";
import type { JudgeProvider, JudgmentResult, JudgmentVerdict } from "./types.js";

/**
 * Options for a judgment pass.
 *
 * `samples` / `judgeTemperature` are the spec-level (or CLI-override) defaults;
 * a criterion's own `samples` / `judge_temperature` fields take precedence.
 * Defaults preserve legacy behavior exactly: 1 sample, provider-default
 * temperature (greedy).
 */
export interface JudgeOptions {
  model?: string;
  /** Default judge samples per judge-method criterion (N-sample majority voting). */
  samples?: number;
  /** Default sampling temperature for judge calls. */
  judgeTemperature?: number;
  /**
   * Wall-clock budget per judge call in milliseconds, threaded to the
   * provider as `timeout_ms`. Defaults to DEFAULT_JUDGE_TIMEOUT_MS — the ONE
   * deliberate behavior change from the legacy engine, which passed no
   * timeout and let a hung judge call stall the whole run.
   */
  judgeTimeoutMs?: number;
  /**
   * Max judge samples in flight per criterion. Unset = all N concurrent
   * (legacy behavior); bound it when the judge endpoint rate-limits bursts
   * (e.g. Groq's free tier at ~30 requests/min).
   */
  sampleConcurrency?: number;
}

/**
 * Default per-call judge timeout. A judge verdict is a small structured
 * completion (~seconds); an unbounded hang is never right — a live NVIDIA NIM
 * call once hung a judge for OVER AN HOUR while execution calls were already
 * bounded. 120s is generous for slow reasoning judges yet turns a hang into a
 * rejected sample, which votes "unsure" under the errored-sample semantics.
 */
export const DEFAULT_JUDGE_TIMEOUT_MS = 120_000;

/**
 * Default judge temperature when multi-sampling (samples >= 2) and neither the
 * criterion nor the run configured one. Majority voting measures agreement
 * across INDEPENDENT draws; sampling a nearly-collapsed temperature-0
 * distribution understates the judge's real variance (temp-0 API calls are
 * still nondeterministic — batch-composition/kernel effects — but barely).
 * 0.7 is the starting arm of the pre-registered temperature sweep in the
 * noise-robust methodology brief (intent-os 000-docs doc 025, after
 * Radharapu et al. N=10/T=0.7); single-call judging keeps the greedy
 * provider default.
 */
export const DEFAULT_MULTI_SAMPLE_JUDGE_TEMPERATURE = 0.7;

/**
 * Judge a set of criteria against an observed outcome.
 *
 * Deterministic checks run first (no API cost).
 * Judge-based criteria use the provided JudgeProvider.
 */
export async function judgeCriteria(
  criteria: Criterion[],
  outcome: ObservedOutcome,
  judgeProvider: JudgeProvider,
  options?: JudgeOptions,
): Promise<JudgmentResult[]> {
  const results: JudgmentResult[] = [];

  for (const criterion of criteria) {
    if (criterion.method === "deterministic") {
      results.push(judgeDeterministic(criterion, outcome));
    } else {
      results.push(await judgeWithLLM(criterion, outcome, judgeProvider, options));
    }
  }

  return results;
}

/**
 * Judge a deterministic criterion using the check registry.
 */
function judgeDeterministic(criterion: Criterion, outcome: ObservedOutcome): JudgmentResult {
  if (!criterion.deterministic_check) {
    return {
      criterion_id: criterion.id,
      verdict: "no",
      confidence: 1,
      reasoning: "Deterministic criterion has no check defined",
      method: "deterministic",
    };
  }

  const checkResult = runCheck(
    criterion.deterministic_check,
    outcome.output.text,
    criterion.deterministic_check_params,
  );

  return {
    criterion_id: criterion.id,
    verdict: checkResult.severity === "pass" ? "yes" : "no",
    confidence: 1,
    reasoning: checkResult.message,
    method: "deterministic",
  };
}

/**
 * Judge a criterion using an external LLM judge.
 *
 * With `samples` = 1 (the default) this is the legacy single-call path,
 * byte-identical in output shape. With `samples` >= 2 it runs N independent
 * judge calls and MAJORITY-VOTES the verdict: an un-seeded LLM judge is
 * nondeterministic even at temperature 0, so a single call makes the binary
 * verdict unstable run-to-run (the SHIP<->BLOCK flip-flop that blocks honest
 * signing). Aggregating N samples turns the noise into a measured
 * `agreement` fraction — reported as `confidence` — instead of silently
 * deciding a release on one draw.
 */
async function judgeWithLLM(
  criterion: Criterion,
  outcome: ObservedOutcome,
  provider: JudgeProvider,
  options?: JudgeOptions,
): Promise<JudgmentResult> {
  const samples = criterion.samples ?? options?.samples ?? 1;
  const temperature =
    criterion.judge_temperature ??
    options?.judgeTemperature ??
    (samples >= 2 ? DEFAULT_MULTI_SAMPLE_JUDGE_TEMPERATURE : undefined);
  const timeoutMs = options?.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  const model = options?.model;

  const callOnce = () =>
    provider.judge(
      criterion.description,
      outcome.prompt,
      outcome.output.text,
      criterion.judge_prompt,
      {
        ...(temperature !== undefined ? { temperature } : {}),
        timeout_ms: timeoutMs,
      },
    );

  if (samples <= 1) {
    try {
      const { verdict, confidence, reasoning } = await callOnce();
      return {
        criterion_id: criterion.id,
        verdict,
        confidence,
        reasoning,
        method: "judge",
        judge_model: model,
      };
    } catch (err) {
      return judgeError(criterion.id, model, err);
    }
  }

  // N-sample path. Samples run concurrently (N is small and bounded by the
  // schema), optionally bounded by `sampleConcurrency` so an N x criteria
  // burst stays under a rate-limited endpoint's requests/min ceiling. A
  // sample that throws votes "unsure": missing evidence must land in the
  // quorum DENOMINATOR and weaken agreement, never silently shrink it —
  // dropping failures would let a 1-of-5 degraded run report agreement 1.0
  // with samples=1 and bypass the stability gate entirely. Only when EVERY
  // sample fails does the result degrade to the legacy error shape.
  const latencies = new Array<number>(samples);
  const settled = await settleWithConcurrency(
    Array.from({ length: samples }, (_, i) => async () => {
      // performance.now() is monotonic — an NTP clock step mid-call cannot
      // produce a negative or skewed latency the way Date.now() deltas can.
      const startedAt = performance.now();
      try {
        return await callOnce();
      } finally {
        latencies[i] = Math.round(performance.now() - startedAt);
      }
    }),
    options?.sampleConcurrency ?? samples,
  );
  const ok = settled.filter(
    (s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof callOnce>>> =>
      s.status === "fulfilled",
  );
  if (ok.length === 0) {
    const firstErr = (settled[0] as PromiseRejectedResult).reason;
    return judgeError(criterion.id, model, firstErr);
  }
  const errored = settled.length - ok.length;

  const votes: Record<JudgmentVerdict, number> = { yes: 0, no: 0, unsure: errored };
  for (const s of ok) votes[s.value.verdict]++;

  const top = Math.max(votes.yes, votes.no, votes.unsure);
  const winners = (Object.keys(votes) as JudgmentVerdict[]).filter((v) => votes[v] === top);
  // A plurality tie has no honest majority — abstain rather than pick a side.
  const verdict: JudgmentVerdict = winners.length === 1 ? winners[0]! : "unsure";
  const agreement = top / settled.length;
  const majoritySample = ok.find((s) => s.value.verdict === verdict) ?? ok[0]!;

  return {
    criterion_id: criterion.id,
    verdict,
    // The measured agreement fraction replaces the judge's self-reported
    // confidence: it is the observed stability of the verdict, not a vibe.
    confidence: agreement,
    reasoning:
      `[${top}/${settled.length} ${winners.length === 1 ? verdict : `tie: ${winners.join("/")}`}]` +
      `${errored > 0 ? ` (${errored} sample(s) errored → unsure)` : ""} ${majoritySample.value.reasoning}`,
    method: "judge",
    judge_model: model,
    samples: settled.length,
    agreement,
    sample_verdicts: settled.map((s) => (s.status === "fulfilled" ? s.value.verdict : "unsure")),
    sample_latencies_ms: latencies,
  };
}

/**
 * Settle `tasks` with at most `limit` in flight, preserving INDEX alignment:
 * `result[i]` is always task i's outcome regardless of completion order, and
 * tasks are dispatched in ascending index order (workers pull the next unclaimed
 * index), so `sample_verdicts` / `sample_latencies_ms` keep dispatch-order
 * semantics. `limit >= tasks.length` is equivalent to Promise.allSettled.
 */
async function settleWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<Array<PromiseSettledResult<T>>> {
  const results = new Array<PromiseSettledResult<T>>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]!() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function judgeError(criterionId: string, model: string | undefined, err: unknown): JudgmentResult {
  return {
    criterion_id: criterionId,
    verdict: "unsure",
    confidence: 0,
    reasoning: `Judge error: ${err instanceof Error ? err.message : String(err)}`,
    method: "judge",
    judge_model: model,
  };
}
