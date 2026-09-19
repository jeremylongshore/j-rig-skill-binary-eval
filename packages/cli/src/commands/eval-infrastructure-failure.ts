import {
  redactProviderError,
  type JudgmentResult,
  type ObservedOutcome,
  type ProviderFailure,
} from "@j-rig/core";

/**
 * Evaluator infrastructure failure — the single rule for `j-rig eval`.
 *
 * Blueprint B § 7.4 (NORMATIVE) defines `gate_decision: "error"` as "a verdict
 * on the gate's own ability to evaluate", never a verdict on the input. So
 * when a provider call the evaluation depends on does not come back, the run
 * produces NO grade — and still produces evidence: one signed `error` row
 * whose `gate_reasons[0]` names the error class and whose
 * `metadata.error_detail` carries the typed, credential-free failure.
 *
 * Two failure shapes count, in either the skill or the naked-baseline pass:
 *  - an execution outcome that did not complete (failed / timed out / carried
 *    a provider error). A completed-but-empty response is NOT a failure: it is
 *    the tool-dependent boundary evidence the eval deliberately keeps.
 *  - a judged criterion whose EVERY sample errored (`judge_error`). Partial
 *    sample loss is not a failure here; the engine already counts an errored
 *    sample as an `unsure` vote so it weakens agreement and trips the
 *    stability gate instead.
 *
 * Any such failure makes the evaluation incomplete, whether it touched one
 * criterion or all of them: a score computed over the criteria that happened
 * to survive is not a measurement of the skill.
 */
export interface EvalInfrastructureFailure {
  type: "provider_failure";
  /** The earliest phase that failed; execution failures mask judge ones. */
  phase: "execution" | "judge";
  provider: string;
  category: ProviderFailure["category"];
  retryable: boolean;
  /** Units (test cases for execution, judged criteria for judge) that failed. */
  affected: number;
  /** Units attempted in that phase. */
  total: number;
  /** Redacted provider message (credential boundary, 000-docs/021). */
  message: string;
}

export interface InfrastructureFailureInput {
  outcomes: readonly ObservedOutcome[];
  judgments: readonly JudgmentResult[];
  executionProvider: string;
  judgeProvider: string;
}

/** True when an execution outcome is a provider failure, not a model response. */
export function isFailedExecution(outcome: ObservedOutcome): boolean {
  return outcome.status !== "completed" || Boolean(outcome.output.error);
}

export function detectInfrastructureFailure(
  input: InfrastructureFailureInput,
): EvalInfrastructureFailure | null {
  const failedOutcomes = input.outcomes.filter(isFailedExecution);
  if (failedOutcomes.length > 0) {
    const first = failedOutcomes[0]!;
    const typed = first.provider_failure;
    const timedOut = first.status === "timed_out" || first.meta.timed_out;
    return {
      type: "provider_failure",
      phase: "execution",
      provider: typed?.providerName ?? input.executionProvider,
      category: typed?.category ?? (timedOut ? "network_timeout" : "unknown"),
      retryable: typed?.retryable ?? timedOut,
      affected: failedOutcomes.length,
      total: input.outcomes.length,
      message: redactProviderError(
        first.output.error ?? `execution ended with status ${first.status}`,
      ),
    };
  }

  const judged = input.judgments.filter((j) => j.method === "judge");
  const dead = judged.filter((j) => typeof j.judge_error === "string");
  if (dead.length === 0) return null;
  const first = dead[0]!;
  return {
    type: "provider_failure",
    phase: "judge",
    provider: first.provider_failure?.providerName ?? input.judgeProvider,
    category: first.provider_failure?.category ?? "unknown",
    retryable: first.provider_failure?.retryable ?? false,
    affected: dead.length,
    total: judged.length,
    message: redactProviderError(first.judge_error),
  };
}

/**
 * The `gate_reasons[0]` sentence. The kernel requires the error class first;
 * the total-judge-outage wording is kept verbatim from the original dead-judge
 * override so existing flap reports and alerts keep matching.
 */
export function infrastructureFailureReason(failure: EvalInfrastructureFailure): string {
  const scope =
    failure.phase === "judge"
      ? failure.affected === failure.total
        ? `judge provider failed on every judged criterion (${failure.affected}/${failure.total}); nothing was evaluated`
        : `judge provider failed on ${failure.affected} of ${failure.total} judged criteria; the evaluation is incomplete`
      : `execution provider failed on ${failure.affected} of ${failure.total} test case(s); the skill was not exercised`;
  return `provider_failure/${failure.phase} [${failure.provider} ${failure.category}${
    failure.retryable ? ", retryable" : ""
  }]: ${scope}: ${failure.message}`;
}
