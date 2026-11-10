import {
  hashValue,
  validateProposedRefinerExperiment,
  type RefinerExperiment,
  type SchemaValidator,
} from "@intentsolutions/refiner-core";
import { assessProposal, type AssessProposalInputs, type ProposalAssessment } from "./assess.js";
import type { EvalRunner } from "./score.js";

export interface OptimizerAssessment {
  readonly assessment: ProposalAssessment;
  /** Absent on blocked assessment; the proposed value is never mutated. */
  readonly experiment?: RefinerExperiment;
}

/** Resolve a bound optimizer experiment only through fresh, quality-gated paired scoring. */
export async function assessOptimizerExperiment(
  inputs: Omit<AssessProposalInputs, "proposal"> & { readonly experiment: unknown },
  runner: EvalRunner,
  validator?: SchemaValidator,
): Promise<OptimizerAssessment> {
  const frozen = structuredClone(inputs);
  const proposed = validateProposedRefinerExperiment(frozen.experiment);
  if (
    hashValue(frozen.doc) !== hashValue(proposed.doc) ||
    hashValue(frozen.evalSet) !== hashValue(proposed.evalSet)
  )
    throw new Error("optimizer experiment: assessment inputs differ from bound inputs");
  if (Date.parse(frozen.now) < Date.parse(proposed.experiment.created_at))
    throw new Error("optimizer experiment: assessment precedes proposal");
  const assessment = await assessProposal(
    { ...frozen, proposal: proposed.editProposal },
    runner,
    validator,
  );
  if (assessment.status === "blocked") return { assessment };
  const before = new Map(assessment.baseline.itemResults.map((item) => [item.itemId, item.passed]));
  const after = new Map(assessment.candidate.itemResults.map((item) => [item.itemId, item.passed]));
  const reasons: string[] = [];
  if (assessment.decision.outcome !== "ACCEPT")
    reasons.push(`refiner-${assessment.decision.outcome.toLowerCase()}`);
  if (before.get(proposed.targetItemId) !== false || after.get(proposed.targetItemId) !== true)
    reasons.push("target-did-not-improve");
  if ([...before].some(([id, passed]) => passed && after.get(id) !== true))
    reasons.push("criterion-regression");
  const accepted = reasons.length === 0;
  return {
    assessment,
    experiment: {
      ...proposed,
      parent: hashValue(proposed),
      experiment: {
        ...proposed.experiment,
        status: accepted ? "accepted" : "rejected",
        improvement: accepted,
        resolved_at: assessment.evaluatedAt,
      },
      resolution: {
        assessmentHash: hashValue(assessment),
        baselineScoreHash: hashValue(assessment.baseline.record),
        candidateScoreHash: hashValue(assessment.candidate.record),
        reasons,
      },
    },
  };
}
