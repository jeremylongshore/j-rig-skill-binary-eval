import {
  composeStatement,
  type EvidenceStatement,
  type HeadroomAssessment,
  type ScoreCard,
  type SkillPromotionEvidence,
  type LaunchReport,
} from "@j-rig/core";
import { buildVoteEvidence, type VoteEvidenceInput } from "./eval-vote-evidence.js";
import type { EvalInfrastructureFailure } from "./eval-infrastructure-failure.js";
import type { storeTriggerEvidence } from "./trigger-evidence.js";
import type { storeToolExecutionEvidence } from "../execution/evidence.js";

export interface EvaluationStatementInput extends VoteEvidenceInput {
  gateId: string;
  infraFailure: EvalInfrastructureFailure | null;
  infraFailureReason: string | null;
  promotionEvidence: SkillPromotionEvidence;
  report: Pick<LaunchReport, "blockers" | "warnings" | "reasoning">;
  triggerEvidence: ReturnType<typeof storeTriggerEvidence>;
  ranRegression: boolean;
  ranBaseline: boolean;
  specContentHash: string;
  skillSnapshotSha: string;
  modelStart: number;
  jrigVersion: string;
  commit: { sha: string; source: string };
  executionMetadata: Record<string, unknown>;
  model: string;
  providers: { providerName: string; real: boolean };
  toolConfig?: { fingerprint: string };
  toolReceipts: ReturnType<typeof storeToolExecutionEvidence>[];
  scoreCard: Pick<
    ScoreCard,
    "pass_rate" | "passed" | "total_criteria" | "unstable_blocker_failures"
  >;
  headroom: HeadroomAssessment | null;
  batchLineage: Record<string, unknown>;
}

/** Construct the existing evaluated-model statement without publishing or mutating run state. */
export function buildEvaluationStatement(input: EvaluationStatementInput): EvidenceStatement {
  const {
    gateId,
    infraFailure,
    infraFailureReason,
    promotionEvidence,
    report,
    triggerEvidence,
    allJudgments,
    scoringCriteria,
    spec,
    judgeSamples,
    scoreCard,
    ranRegression,
    ranBaseline,
    specContentHash,
    skillSnapshotSha,
    modelStart,
    jrigVersion,
    commit,
    executionMetadata,
    model,
    providers,
    toolConfig,
    toolReceipts,
    headroom,
    batchLineage,
  } = input;
  const gateDecision = infraFailure ? "error" : promotionEvidence.gate_decision;
  const gateReasons = [
    ...new Set([
      ...report.blockers,
      ...report.warnings,
      // Promotion reasons describe a verdict; an `error` row has none.
      ...(infraFailure ? [] : promotionEvidence.promotion_reasons),
    ]),
  ];
  if (infraFailureReason) gateReasons.unshift(infraFailureReason);
  if (gateReasons.length === 0) {
    gateReasons.push(report.reasoning || "all criteria met");
  }
  const triggerRan = triggerEvidence.status === "complete";
  // Vote evidence (audit-substrate review, finding 1): the signed
  // predicate must carry the FOLD INPUTS — per-judgment samples,
  // agreement, and per-sample verdicts — plus the aggregation rule
  // in force, so a verifier can re-derive the verdict from the
  // signed bytes ("majority of these N recorded votes", never
  // "the judge said so"). `stability` is present IFF multi-
  // sampling actually ran, so absence unambiguously means "no
  // stability evidence" — never a fake measured-0.
  const voteEvidence = buildVoteEvidence({
    allJudgments,
    scoringCriteria,
    spec,
    judgeSamples,
    scoreCard,
  });
  const hasJudgeCriteria = allJudgments.some((j) => j.method === "judge");
  return composeStatement({
    gateId,
    gateDecision,
    gateName: "rollout",
    gateVersion: jrigVersion,
    gateReasons,
    coverage: {
      dimensionsEvaluated: [
        ...(triggerRan ? ["trigger"] : []),
        "functional",
        "behavioral",
        ...(ranRegression ? ["regression"] : []),
        ...(ranBaseline ? ["baseline"] : []),
      ],
      dimensionsSkipped: [
        ...(triggerRan ? [] : ["trigger"]),
        ...(ranRegression ? [] : ["regression"]),
        ...(ranBaseline ? [] : ["baseline"]),
      ],
    },
    policyRef: `${specContentHash}:eval-spec.yaml`,
    policyHash: specContentHash,
    inputHash: skillSnapshotSha,
    evaluatedAt: new Date(modelStart).toISOString(),
    runner: `j-rig@${jrigVersion}`,
    commitSha: commit.sha,
    metadata: {
      ...executionMetadata,
      trigger: triggerEvidence,
      model,
      provider: providers.providerName,
      ground_truth: providers.real,
      ...(toolConfig
        ? {
            tool_execution: {
              transport: "mcp-stdio",
              configuration_sha256: toolConfig.fingerprint,
              session_scope: "fresh_process_per_case",
              baseline_same_capabilities: true,
              receipts: toolReceipts,
            },
          }
        : {}),
      pass_rate: scoreCard.pass_rate,
      passed: scoreCard.passed,
      total_criteria: scoreCard.total_criteria,
      commit_sha_source: commit.source,
      // Blueprint B § 7.4 SHOULD: structured detail for `error`.
      // Mutually exclusive with promotion evidence (see above).
      ...(infraFailure ? { error_detail: infraFailure } : promotionEvidence),
      ...(headroom ? { headroom } : {}),
      ...batchLineage,
      ...voteEvidence,
    },
    // Honest replay-fidelity claim: an un-seeded API judge caps the
    // statement below RF-2 (the OTel llm_no_seed classification) —
    // the fold is replayable from the recorded votes above, the
    // votes are not reproducible from scratch. Pure-deterministic
    // runs make no claim rather than guessing a higher level.
    ...(hasJudgeCriteria ? { replayFidelityLevel: "RF-1" as const } : {}),
    ...(gateDecision === "fail"
      ? {
          failureMode:
            report.blockers[0] ??
            promotionEvidence.promotion_reasons.at(-1) ??
            "promotion-evidence-failed",
        }
      : {}),
    ...(gateDecision === "advisory" ? { advisorySeverity: "warn" as const } : {}),
  });
}
