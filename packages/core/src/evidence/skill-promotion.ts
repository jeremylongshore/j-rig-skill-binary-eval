import { createHash } from "node:crypto";
import { z } from "zod";
// One canonicalizer behind every content hash in core: reusing the adapter's
// keeps grader-snapshot digests and SkillEvalSpec digests byte-compatible.
import { canonicalJson } from "../schemas/skill-eval-spec-adapter.js";
import type {
  BaselineComparison,
  Regression,
  RolloutDecision,
  ScoreCard,
} from "../governance/types.js";

/** Versioned metadata contract attached to a real skill-evaluation gate row. */
export const SKILL_PROMOTION_EVIDENCE_SCHEMA = "j-rig/skill-promotion/v1" as const;

const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const DecisionSchema = z.enum(["ship", "warn", "block", "obsolete_review"]);

export const SkillPromotionEvidenceSchema = z
  .object({
    schema: z.literal(SKILL_PROMOTION_EVIDENCE_SCHEMA),
    eval_run_id: z.string().uuid(),
    run_ids: z.array(z.string().uuid()).min(1),
    storage_run_id: z.number().int().positive(),
    storage_run_ids: z.array(z.number().int().positive()).min(1),
    skill: z.object({
      skill_version_id: z.string().min(1),
      name: z.string().min(1),
      version: z.string().min(1),
      snapshot_sha256: Sha256Schema,
    }),
    eval_spec: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      profile_sha256: Sha256Schema,
      identity_kind: z.literal("j-rig-skill-profile"),
    }),
    selected_grader: z.object({
      grader_id: z.string().min(1),
      grader_version: z.string().min(1),
      grader_snapshot_sha256: Sha256Schema,
    }),
    thresholds: z.object({
      status: z.enum(["pass", "fail"]),
      required_pass_rate: z.literal(1),
      observed_pass_rate: z.number().min(0).max(1),
      total_criteria: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      unsure: z.number().int().nonnegative(),
      blocker_failures: z.number().int().nonnegative(),
      min_blocker_agreement: z.number().min(0.5).max(1).nullable(),
      unstable_blocker_failures: z.number().int().nonnegative(),
    }),
    regression: z
      .object({
        required: z.literal(true),
        enabled: z.boolean(),
        baseline_sha256: Sha256Schema.nullable(),
        result: z.enum(["not-run", "no-regressions", "regressions-found"]),
        count: z.number().int().nonnegative(),
        sacred_count: z.number().int().nonnegative(),
      })
      .superRefine((regression, ctx) => {
        if (!regression.enabled) {
          if (regression.result !== "not-run") {
            ctx.addIssue({
              code: "custom",
              message: "disabled regression coverage must be not-run",
            });
          }
          if (regression.baseline_sha256 !== null) {
            ctx.addIssue({
              code: "custom",
              message: "disabled regression coverage cannot have a baseline hash",
            });
          }
          if (regression.count !== 0 || regression.sacred_count !== 0) {
            ctx.addIssue({
              code: "custom",
              message: "disabled regression coverage cannot report regressions",
            });
          }
        } else {
          if (regression.baseline_sha256 === null) {
            ctx.addIssue({
              code: "custom",
              message: "enabled regression coverage requires a baseline hash",
            });
          }
          const expected = regression.count === 0 ? "no-regressions" : "regressions-found";
          if (regression.result !== expected) {
            ctx.addIssue({
              code: "custom",
              message: `regression result must be ${expected} for count=${regression.count}`,
            });
          }
          if (regression.sacred_count > regression.count) {
            ctx.addIssue({
              code: "custom",
              message: "sacred regression count cannot exceed total count",
            });
          }
        }
      }),
    baseline: z.object({
      enabled: z.boolean(),
      result: z.enum(["not-run", "adds-value", "obsolete-review", "no-comparison"]),
      comparison_count: z.number().int().nonnegative(),
      value_addition_count: z.number().int().nonnegative(),
    }),
    rollout_decision: DecisionSchema,
    promotion_eligible: z.boolean(),
    promotion_reasons: z.array(z.string().min(1)).min(1),
    gate_decision: z.enum(["pass", "fail", "advisory"]),
  })
  .superRefine((evidence, ctx) => {
    if (!evidence.run_ids.includes(evidence.eval_run_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["run_ids"],
        message: "run_ids must include eval_run_id",
      });
    }

    const thresholdsPass =
      evidence.thresholds.total_criteria > 0 &&
      evidence.thresholds.observed_pass_rate === 1 &&
      evidence.thresholds.failed === 0 &&
      evidence.thresholds.unsure === 0 &&
      evidence.thresholds.blocker_failures === 0;
    if ((evidence.thresholds.status === "pass") !== thresholdsPass) {
      ctx.addIssue({
        code: "custom",
        path: ["thresholds", "status"],
        message: "threshold status does not match the observed score",
      });
    }

    const regressionPass = evidence.regression.result === "no-regressions";
    const promotionEligible =
      evidence.rollout_decision === "ship" && thresholdsPass && regressionPass;
    if (evidence.promotion_eligible !== promotionEligible) {
      ctx.addIssue({
        code: "custom",
        path: ["promotion_eligible"],
        message:
          "promotion eligibility does not match decision, thresholds, and regression evidence",
      });
    }

    const expectedGateDecision =
      evidence.rollout_decision === "block" || evidence.regression.sacred_count > 0
        ? "fail"
        : promotionEligible
          ? "pass"
          : "advisory";
    if (evidence.gate_decision !== expectedGateDecision) {
      ctx.addIssue({
        code: "custom",
        path: ["gate_decision"],
        message: `gate decision must be ${expectedGateDecision}`,
      });
    }
  });

export type SkillPromotionEvidence = z.infer<typeof SkillPromotionEvidenceSchema>;

export interface SkillPromotionEvidenceInput {
  evalRunId: string;
  storageRunId: number;
  skill: {
    name: string;
    version: string;
    snapshotSha256: string;
  };
  evalSpec: {
    id: string;
    version: string;
    profileSha256: string;
  };
  selectedGrader: {
    graderId: string;
    graderVersion: string;
    graderSnapshotSha256: string;
  };
  score: ScoreCard;
  minBlockerAgreement: number | null;
  regressions: Regression[];
  regressionEnabled: boolean;
  regressionBaselineSha256: string | null;
  baselineEnabled: boolean;
  baselineComparisons: BaselineComparison[];
  isObsolete: boolean;
  rolloutDecision: RolloutDecision;
}

/** Return a platform-style, sha256-prefixed digest of a JSON value. */
export function hashCanonicalJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/** Build and cross-validate the producer-side promotion metadata contract. */
export function buildSkillPromotionEvidence(
  input: SkillPromotionEvidenceInput,
): SkillPromotionEvidence {
  const sacredCount = input.regressions.filter((regression) => regression.is_sacred).length;
  const thresholdPass =
    input.score.total_criteria > 0 &&
    input.score.pass_rate === 1 &&
    input.score.failed === 0 &&
    input.score.unsure === 0 &&
    input.score.blocker_failures === 0;
  const regressionResult = !input.regressionEnabled
    ? "not-run"
    : input.regressions.length === 0
      ? "no-regressions"
      : "regressions-found";
  const promotionEligible =
    input.rolloutDecision === "ship" && thresholdPass && regressionResult === "no-regressions";
  const gateDecision =
    input.rolloutDecision === "block" || sacredCount > 0
      ? "fail"
      : promotionEligible
        ? "pass"
        : "advisory";

  const promotionReasons: string[] = [];
  if (thresholdPass) promotionReasons.push("thresholds passed");
  else promotionReasons.push("thresholds did not pass");
  if (regressionResult === "not-run") {
    promotionReasons.push("regression comparison was not run");
  } else if (regressionResult === "no-regressions") {
    promotionReasons.push("regression comparison passed");
  } else {
    promotionReasons.push(`${input.regressions.length} regression(s) detected`);
  }
  if (input.rolloutDecision !== "ship") {
    promotionReasons.push(`rollout decision is ${input.rolloutDecision}`);
  }

  const baselineResult = !input.baselineEnabled
    ? "not-run"
    : input.isObsolete
      ? "obsolete-review"
      : input.baselineComparisons.length === 0
        ? "no-comparison"
        : "adds-value";

  return SkillPromotionEvidenceSchema.parse({
    schema: SKILL_PROMOTION_EVIDENCE_SCHEMA,
    eval_run_id: input.evalRunId,
    run_ids: [input.evalRunId],
    storage_run_id: input.storageRunId,
    storage_run_ids: [input.storageRunId],
    skill: {
      skill_version_id: `j-rig:skill-version:${input.skill.snapshotSha256.slice("sha256:".length)}`,
      name: input.skill.name,
      version: input.skill.version,
      snapshot_sha256: input.skill.snapshotSha256,
    },
    eval_spec: {
      id: input.evalSpec.id,
      version: input.evalSpec.version,
      profile_sha256: input.evalSpec.profileSha256,
      identity_kind: "j-rig-skill-profile",
    },
    selected_grader: {
      grader_id: input.selectedGrader.graderId,
      grader_version: input.selectedGrader.graderVersion,
      grader_snapshot_sha256: input.selectedGrader.graderSnapshotSha256,
    },
    thresholds: {
      status: thresholdPass ? "pass" : "fail",
      required_pass_rate: 1,
      observed_pass_rate: input.score.pass_rate,
      total_criteria: input.score.total_criteria,
      passed: input.score.passed,
      failed: input.score.failed,
      unsure: input.score.unsure,
      blocker_failures: input.score.blocker_failures,
      min_blocker_agreement: input.minBlockerAgreement,
      unstable_blocker_failures: input.score.unstable_blocker_failures ?? 0,
    },
    regression: {
      required: true,
      enabled: input.regressionEnabled,
      baseline_sha256: input.regressionBaselineSha256,
      result: regressionResult,
      count: input.regressions.length,
      sacred_count: sacredCount,
    },
    baseline: {
      enabled: input.baselineEnabled,
      result: baselineResult,
      comparison_count: input.baselineComparisons.length,
      value_addition_count: input.baselineComparisons.filter(
        (comparison) => comparison.skill_adds_value,
      ).length,
    },
    rollout_decision: input.rolloutDecision,
    promotion_eligible: promotionEligible,
    promotion_reasons: promotionReasons,
    gate_decision: gateDecision,
  });
}
