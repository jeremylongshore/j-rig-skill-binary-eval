import {
  assessHeadroom,
  GateDecision,
  type LaunchReport,
  type ScoreCard,
  type RolloutDecision,
  type checkPackage,
} from "@j-rig/core";
import type { SkillEvalSpec } from "../lib/loaders.js";
import type { EvalCostReport } from "../providers/cost-tracking.js";
import { icon } from "../lib/output.js";
import { infrastructureFailureReason } from "./eval-infrastructure-failure.js";
import { formatHeadroom } from "./eval-governance-phase.js";
import type { EvaluatedModelCompletionInput } from "./eval-model-completion.js";

type ModelResultInput = Pick<
  EvaluatedModelCompletionInput,
  | "opts"
  | "infraFailure"
  | "model"
  | "outcomes"
  | "allJudgments"
  | "promotionEvidence"
  | "executionMetadata"
  | "batchLineage"
  | "subscriptionExecution"
  | "triggerEvidence"
> & {
  report: LaunchReport;
  scoreCard: ScoreCard;
  spec: Pick<SkillEvalSpec, "headroom_ceiling">;
  providers: {
    providerName: string;
    judgeProviderName: string;
    judgeModelId: string;
    real: boolean;
  };
  pkgReport: ReturnType<typeof checkPackage>;
  decision: RolloutDecision;
  costReport: EvalCostReport | null;
};

/** Describe a model result without allowing incomplete execution to claim promotion. */
export function describeEvaluatedModel(input: ModelResultInput) {
  const {
    infraFailure,
    scoreCard,
    spec,
    report,
    opts,
    executionMetadata,
    providers,
    model,
    pkgReport,
    subscriptionExecution,
    outcomes,
    allJudgments,
    decision,
    promotionEvidence,
    costReport,
    batchLineage,
    triggerEvidence,
  } = input;
  // ── Infrastructure-failure rule (000-docs/037) ─────────────
  // Blueprint B § 7.4: `error` is "a verdict on the gate's own
  // ability to evaluate". ANY unrecovered provider failure — a test
  // case that never executed, or a criterion whose every judge sample
  // errored, in the skill or the naked-baseline pass — means the
  // scorecard below was computed over an incomplete evaluation. It is
  // kept for diagnosis but is not a verdict on the skill: the row is
  // signed `error`, the run is stored `failed`, the exit is non-zero.
  // This generalizes the 2026-09 dead-judge override (conference
  // audit, "make it lie" #E), which fired only when EVERY judgment
  // died and ignored execution failures entirely.
  const infraFailureReason = infraFailure ? infrastructureFailureReason(infraFailure) : null;

  // ── Headroom (000-docs/043) ────────────────────────────────
  // Can this eval still show that a change helped? A measurement of
  // the eval, not the skill: it rides beside the decision and never
  // changes it. An infrastructure failure has no verdict, so it gets
  // no headroom claim either.
  const headroom = infraFailure
    ? null
    : assessHeadroom({
        passed: scoreCard.passed,
        trials: scoreCard.total_criteria,
        ceiling: spec.headroom_ceiling,
      });
  if (headroom) {
    report.headroom = headroom;
    if (!opts.json && headroom.status !== "headroom") {
      console.log(`  ${icon("warning")} ${formatHeadroom(headroom)}`);
    }
  }

  const result = {
    ...executionMetadata,
    provider: providers.providerName,
    model,
    judge_provider: providers.judgeProviderName,
    judge_model: providers.judgeModelId,
    ground_truth: providers.real,
    pkgReport,
    trigger: triggerEvidence,
    // The observed tool-call order + produced-file manifest per case
    // (claude-code execution only): the record the trajectory checks
    // graded, kept so a reader can re-check a verdict.
    ...(subscriptionExecution
      ? {
          trajectories: outcomes.map((o) => ({
            test_case_id: o.test_case_id,
            status: o.status,
            ...(o.output.error ? { error: o.output.error } : {}),
            input_tokens: o.meta.input_tokens ?? null,
            output_tokens: o.meta.output_tokens ?? null,
            // Claude Code's own API-equivalent figure; on the
            // subscription this is not a bill.
            cost_usd_api_equivalent: o.meta.estimated_cost_usd ?? null,
            ...(o.output.trajectory ? { trajectory: o.output.trajectory } : {}),
          })),
        }
      : {}),
    scoreCard,
    // Exact per-case verdicts for downstream frozen-input scoring.
    // Deliberately omit model text and judge explanations.
    criterion_results: allJudgments.map((judgment) => ({
      criterion_id: judgment.criterion_id,
      test_case_id: judgment.test_case_id,
      verdict: judgment.verdict,
    })),
    decision,
    report,
    // Exactly one of these is present. An incomplete evaluation
    // carries `evaluation_error` and NO promotion evidence: a
    // promotion claim over criteria that were never evaluated would
    // be meaningless, and its own pass|fail|advisory field would
    // contradict the `error` verdict.
    ...(infraFailure
      ? { gate_decision: "error", evaluation_error: infraFailure }
      : { promotion: promotionEvidence }),
    cost: costReport,
    ...batchLineage,
  };

  // OTel gate.decision.emitted (067 § 2.2). Map the j-rig
  // RolloutDecision plus promotion evidence onto the closed
  // gate-result/v1 verdict enum {pass,fail,advisory,error}. A `ship`
  // decision without the required regression comparison is advisory
  // until the evidence is complete; this prevents a skipped layer
  // from becoming a false promotion pass. Spelling is identical to
  // the audit-harness iah-E07 emitter so a ship-gate dashboard alerts
  // on one event name across both emitters.
  //
  // Infrastructure failure wins over every other mapping, promotion
  // included: the kernel enum has `error` for exactly this, and
  // gate_reasons[0] must name the error class (computed above).
  const gateDecisionValue = infraFailure
    ? GateDecision.ERROR
    : promotionEvidence.gate_decision === "pass"
      ? GateDecision.PASS
      : promotionEvidence.gate_decision === "fail"
        ? GateDecision.FAIL
        : GateDecision.ADVISORY;
  return { result, infraFailureReason, headroom, gateDecisionValue };
}
