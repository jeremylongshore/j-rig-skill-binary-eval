import {
  applyEdit,
  decide,
  evaluateEvalSet,
  hashValue,
  isRefreshDue,
  kernelSkillFrontmatterValidator,
  leakage,
  type AdversarialEvalItem,
  type CalibrationPrediction,
  type CapabilityManifest,
  type DecideOutcome,
  type EditProposal,
  type EvalItem,
  type EvalSet,
  type EvalSetQualityReport,
  type SchemaValidator,
  type SkillDoc,
} from "@intentsolutions/refiner-core";
import {
  checkedInputs,
  scoreWithEvidence,
  type EvalRunner,
  type ScoreOptions,
  type ScoredEvaluation,
} from "./score.js";

/** Explicit project policy; no invented universal quality thresholds. */
export interface AcceptanceQualityPolicy {
  readonly maxLeakage: number;
  readonly maxDuplicateRatio: number;
  readonly maxBrierScore: number;
  readonly maxEce: number;
  readonly minCalibrationSamples: number;
  readonly minAdversarialItems: number;
}

/** Reviewed inputs, content-addressed with the assessment for later inspection. */
export interface AcceptanceQualityEvidence {
  readonly evalSetHash: string;
  readonly manifest: CapabilityManifest;
  readonly referenceItems: readonly EvalItem[];
  readonly predictions: readonly CalibrationPrediction[];
  readonly judge: { readonly provider: string; readonly model: string };
  readonly verifiedEvalSet: true;
  readonly reviewedAt: string;
  readonly expiresAt: string;
}

export interface AssessProposalInputs {
  readonly doc: SkillDoc;
  readonly proposal: EditProposal;
  readonly evalSet: EvalSet;
  readonly quality?: AcceptanceQualityEvidence;
  readonly policy: AcceptanceQualityPolicy;
  /** Injected clock; CLI supplies wall-clock UTC, library callers must provide it. */
  readonly now: string;
  readonly scoreOptions: ScoreOptions;
}

export type ProposalAssessment =
  | { readonly status: "blocked"; readonly reasons: readonly string[] }
  | {
      readonly status: "evaluated";
      readonly decision: DecideOutcome;
      readonly baseline: ScoredEvaluation;
      readonly candidate: ScoredEvaluation;
      readonly candidateDoc: SkillDoc;
      readonly baselineDoc: SkillDoc;
      readonly evalSet: EvalSet;
      readonly proposal: EditProposal;
      readonly qualityReport: EvalSetQualityReport;
      readonly qualityEvidence: AcceptanceQualityEvidence;
      readonly qualityEvidenceHash: string;
      readonly policy: AcceptanceQualityPolicy;
      readonly policyHash: string;
      readonly evaluatedAt: string;
    };

/**
 * Assess a proposal with fresh paired scores only after quality preconditions.
 * This composes the existing apply/score/decide operations; it never promotes a
 * best pointer or signs evidence. Historical aggregate scores cannot enter here.
 * Reviewed declarations/calibration are supplied evidence, not independently
 * verified human identity or semantic truth. Their bytes and policy are retained.
 */
export async function assessProposal(
  inputs: AssessProposalInputs,
  runner: EvalRunner,
  validator: SchemaValidator = kernelSkillFrontmatterValidator(),
): Promise<ProposalAssessment> {
  const frozen = structuredClone(inputs);
  const { doc, evalSet } = checkedInputs(frozen.doc, frozen.evalSet);
  const { quality, policy, now } = frozen;
  const blocked = (...reasons: string[]): ProposalAssessment => ({ status: "blocked", reasons });
  if (!validPolicy(policy)) return blocked("invalid-quality-policy");
  if (!quality) return blocked("missing-quality-evidence");
  if (quality.evalSetHash !== evalSet.hash) return blocked("quality-eval-set-mismatch");
  if (quality.verifiedEvalSet !== true) return blocked("unreviewed-eval-set");
  const current = Date.parse(now);
  const reviewed = Date.parse(quality.reviewedAt);
  const expires = Date.parse(quality.expiresAt);
  if (
    ![current, reviewed, expires].every(Number.isFinite) ||
    reviewed > current ||
    expires <= current ||
    expires <= reviewed
  ) {
    return blocked("invalid-or-expired-quality-evidence");
  }
  if (isRefreshDue(evalSet, { now, treatNullAsDue: true })) return blocked("eval-set-refresh-due");
  if (
    !quality.judge ||
    typeof quality.judge.provider !== "string" ||
    !quality.judge.provider.trim() ||
    typeof quality.judge.model !== "string" ||
    !quality.judge.model.trim()
  )
    return blocked("missing-calibrated-judge");
  if (
    !Array.isArray(quality.referenceItems) ||
    quality.referenceItems.length === 0 ||
    quality.referenceItems.some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        !item.id.trim() ||
        typeof item.prompt !== "string" ||
        !item.prompt.trim(),
    )
  ) {
    return blocked("missing-or-invalid-leakage-reference");
  }
  if (
    !Array.isArray(quality.predictions) ||
    quality.predictions.length < policy.minCalibrationSamples ||
    quality.predictions.some(
      (prediction) =>
        !prediction ||
        typeof prediction.correct !== "boolean" ||
        !Number.isFinite(prediction.confidence) ||
        prediction.confidence < 0 ||
        prediction.confidence > 1,
    )
  ) {
    return blocked("missing-or-invalid-calibration-evidence");
  }
  const adversarialCount = evalSet.items.filter(
    (item) => (item as AdversarialEvalItem).adversarial === true,
  ).length;
  if (adversarialCount < policy.minAdversarialItems)
    return blocked("insufficient-adversarial-items");
  let qualityReport: EvalSetQualityReport;
  try {
    if (!quality.manifest) return blocked("missing-capability-manifest");
    qualityReport = evaluateEvalSet(evalSet, {
      capabilityManifest: quality.manifest,
      referenceItems: quality.referenceItems,
      predictions: quality.predictions,
    });
  } catch {
    return blocked("invalid-capability-manifest");
  }
  const reasons: string[] = [];
  if (qualityReport.capabilityCoverage?.complete !== true)
    reasons.push("incomplete-capability-coverage");
  if (qualityReport.leakage.overlapRatio > policy.maxLeakage) reasons.push("reference-leakage");
  if (leakage(evalSet.items, evalSet.items).overlapRatio > policy.maxDuplicateRatio)
    reasons.push("duplicate-eval-prompts");
  if (
    qualityReport.calibration!.brierScore > policy.maxBrierScore ||
    qualityReport.calibration!.ece > policy.maxEce
  )
    reasons.push("poor-judge-calibration");
  if (reasons.length > 0) return blocked(...reasons);

  const candidateDoc = applyEdit(doc, frozen.proposal);
  const baseline = await scoreWithEvidence(doc, evalSet, runner, frozen.scoreOptions);
  if (!sameJudge(baseline, quality)) return blocked("calibrated-judge-mismatch");
  const candidate = await scoreWithEvidence(candidateDoc, evalSet, runner, frozen.scoreOptions);
  if (!sameJudge(candidate, quality)) return blocked("calibrated-judge-mismatch");
  if (
    !baseline.record.dimensions.adversarial_pass_rate ||
    !candidate.record.dimensions.adversarial_pass_rate
  ) {
    return blocked("missing-adversarial-score-evidence");
  }
  return {
    status: "evaluated",
    decision: decide({
      proposal: frozen.proposal,
      appliedDocText: candidateDoc.text,
      baseline: baseline.record,
      candidate: candidate.record,
      validator,
    }),
    baseline,
    candidate,
    candidateDoc,
    baselineDoc: doc,
    evalSet,
    proposal: frozen.proposal,
    qualityReport: evaluateEvalSet(evalSet, {
      capabilityManifest: quality.manifest,
      referenceItems: quality.referenceItems,
      predictions: quality.predictions,
      itemResults: candidate.itemResults,
    }),
    qualityEvidence: quality,
    qualityEvidenceHash: hashValue(quality),
    policy,
    policyHash: hashValue(policy),
    evaluatedAt: now,
  };
}

function sameJudge(scored: ScoredEvaluation, quality: AcceptanceQualityEvidence): boolean {
  return (
    scored.judge.provider === quality.judge.provider && scored.judge.model === quality.judge.model
  );
}

function validPolicy(policy: AcceptanceQualityPolicy): boolean {
  if (!policy) return false;
  return (
    [policy.maxLeakage, policy.maxDuplicateRatio, policy.maxBrierScore, policy.maxEce].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
    ) &&
    [policy.minCalibrationSamples, policy.minAdversarialItems].every(
      (value) => Number.isSafeInteger(value) && value >= 1,
    )
  );
}
