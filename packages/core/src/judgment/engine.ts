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
}

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
  const temperature = criterion.judge_temperature ?? options?.judgeTemperature;
  const model = options?.model;

  const callOnce = () =>
    provider.judge(
      criterion.description,
      outcome.prompt,
      outcome.output.text,
      criterion.judge_prompt,
      temperature !== undefined ? { temperature } : undefined,
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
  // schema); a sample that throws is DROPPED from the tally rather than
  // polluting it with a synthetic "unsure" vote — unless every sample fails,
  // which degrades to the legacy error result.
  const settled = await Promise.allSettled(Array.from({ length: samples }, callOnce));
  const ok = settled.filter(
    (s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof callOnce>>> =>
      s.status === "fulfilled",
  );
  if (ok.length === 0) {
    const firstErr = (settled[0] as PromiseRejectedResult).reason;
    return judgeError(criterion.id, model, firstErr);
  }

  const votes: Record<JudgmentVerdict, number> = { yes: 0, no: 0, unsure: 0 };
  for (const s of ok) votes[s.value.verdict]++;

  const top = Math.max(votes.yes, votes.no, votes.unsure);
  const winners = (Object.keys(votes) as JudgmentVerdict[]).filter((v) => votes[v] === top);
  // A plurality tie has no honest majority — abstain rather than pick a side.
  const verdict: JudgmentVerdict = winners.length === 1 ? winners[0]! : "unsure";
  const agreement = top / ok.length;
  const majoritySample = ok.find((s) => s.value.verdict === verdict) ?? ok[0]!;

  return {
    criterion_id: criterion.id,
    verdict,
    // The measured agreement fraction replaces the judge's self-reported
    // confidence: it is the observed stability of the verdict, not a vibe.
    confidence: agreement,
    reasoning: `[${top}/${ok.length} ${winners.length === 1 ? verdict : `tie: ${winners.join("/")}`}] ${majoritySample.value.reasoning}`,
    method: "judge",
    judge_model: model,
    samples: ok.length,
    agreement,
    sample_verdicts: ok.map((s) => s.value.verdict),
  };
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
