import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  computeScoreCard,
  decideRollout,
  buildLaunchReport,
  detectRegressions,
  buildSkillPromotionEvidence,
  hashCanonicalJson,
  type JudgmentResult,
  type Regression,
  type BaselineComparison,
  type EvalCorrelation,
  type HeadroomAssessment,
} from "@j-rig/core";
import type { SkillEvalSpec } from "../lib/loaders.js";
import { buildGraderSnapshot } from "./eval-grader-snapshot.js";

type GovernanceInput = Parameters<typeof buildGraderSnapshot>[0] & {
  opts: { regressionBaseline?: string; json?: boolean };
  spec: SkillEvalSpec;
  allJudgments: JudgmentResult[];
  isObsolete: boolean;
  skillName: string;
  baselineComparisons: BaselineComparison[];
  modelStart: number;
  correlation: EvalCorrelation;
  runId: number;
  skillVersion: string;
  skillSnapshotSha: string;
  specContentHash: string;
  jrigVersion: string;
  ranBaseline: boolean;
};

/** Compute regression/governance evidence only after all execution admission boundaries. */
export function evaluateModelGovernance(input: GovernanceInput) {
  const {
    opts,
    allJudgments,
    scoringCriteria,
    spec,
    isObsolete,
    skillName,
    baselineComparisons,
    modelStart,
    executionMetadata,
    toolConfig,
    providers,
    judgeSamples,
    correlation,
    runId,
    skillVersion,
    skillSnapshotSha,
    specContentHash,
    jrigVersion,
    ranBaseline,
  } = input;
  // Layer 4 — Regression protection (opt-in --regression-baseline <path>):
  // compare this run against a prior run's judgments. A criterion that
  // passed before and now fails is a regression; a SACRED regression
  // (criterion.regression_critical) BLOCKS regardless of average gain —
  // computeScoreCard folds sacred_regressions into the decision. Without
  // a baseline the layer is honestly skipped (reported below).
  let regressions: Regression[] = [];
  let ranRegression = false;
  let regressionBaselineSha256: string | null = null;
  if (opts.regressionBaseline) {
    ranRegression = true;
    const baseline = loadRegressionBaselineSnapshot(opts.regressionBaseline);
    regressionBaselineSha256 = baseline.sha256;
    regressions = detectRegressions(baseline.judgments, allJudgments, scoringCriteria);
    if (!opts.json) {
      const sacred = regressions.filter((r) => r.is_sacred).length;
      console.log(
        `  Regression: ${regressions.length} regression(s) vs baseline` +
          (sacred > 0 ? ` — ${sacred} SACRED (BLOCKS)` : ""),
      );
    }
  }

  const scoreCard = computeScoreCard(allJudgments, scoringCriteria, regressions, {
    // Stability gate: a multi-sampled blocker "no" below this
    // agreement fraction downgrades to a warning — a verdict too
    // unstable to reproduce is too unstable to BLOCK (or sign) on.
    min_blocker_agreement: spec.min_blocker_agreement,
  });
  const decision = decideRollout(scoreCard, isObsolete);
  const report = buildLaunchReport(
    skillName,
    scoreCard,
    regressions,
    baselineComparisons,
    isObsolete,
    // DR-103 D5 B5.1: inject `now` so the launch-report artifact is
    // replayable (the determinism the adoption signal's bandit-rejection
    // rests on). One timestamp per model run.
    { now: new Date(modelStart).toISOString() },
  );

  // The legacy skill evaluator predates the generic Run/Grade
  // substrate, so make its effective grader explicit and immutable
  // in the promotion metadata. The snapshot covers every criterion
  // plus the judge/stability settings that influence the fold.
  const graderSnapshot = buildGraderSnapshot({
    executionMetadata,
    toolConfig,
    scoringCriteria,
    providers,
    judgeSamples,
    spec,
  });
  const promotionEvidence = buildSkillPromotionEvidence({
    evalRunId: correlation.evalRunId,
    storageRunId: runId,
    skill: {
      name: skillName,
      version: skillVersion,
      snapshotSha256: skillSnapshotSha,
    },
    evalSpec: {
      id: `j-rig:skill-profile:${sanitizeSegment(skillName, "skill")}`,
      version: spec.spec_version,
      profileSha256: specContentHash,
    },
    selectedGrader: {
      graderId: "j-rig-binary-criteria",
      graderVersion: jrigVersion,
      graderSnapshotSha256: hashCanonicalJson(graderSnapshot),
    },
    score: scoreCard,
    minBlockerAgreement: spec.min_blocker_agreement ?? null,
    regressions,
    regressionEnabled: ranRegression,
    regressionBaselineSha256,
    baselineEnabled: ranBaseline,
    baselineComparisons,
    isObsolete,
    rolloutDecision: report.decision,
  });
  return { regressions, ranRegression, scoreCard, decision, report, promotionEvidence };
}

/**
 * Sanitize an arbitrary string (skill name, model name) into a valid gate-id
 * trailing segment: chars limited to `[A-Za-z0-9.-]` and a leading
 * `[A-Za-z0-9]`, per the kernel SubjectName regex
 * `…:(client|server|ci|sandbox|local):[a-zA-Z0-9][a-zA-Z0-9.-]*`. Both the skill
 * name and the model are passed through this so a SKILL.md with a non-kebab
 * `name` (underscores, leading digit hyphen, etc.) can't produce a gate_id that
 * fails composeStatement's fail-closed validation.
 */
export function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Load a prior run's judgments for the Layer-4 regression comparison
 * (--regression-baseline). Accepts a JSON array of { criterion_id, verdict };
 * only those two fields drive detectRegressions, so the loaded rows are minimal
 * JudgmentResults. Fails LOUD on a malformed file rather than silently skipping
 * the regression layer — a silent skip would hide a real regression.
 */
export function loadRegressionBaseline(path: string): JudgmentResult[] {
  return loadRegressionBaselineSnapshot(path).judgments;
}

/** Bind the comparison and evidence digest to one exact filesystem snapshot. */
function loadRegressionBaselineSnapshot(path: string): {
  judgments: JudgmentResult[];
  sha256: string;
} {
  let raw: unknown;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    throw new Error(
      `--regression-baseline: could not read/parse "${path}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      `--regression-baseline: "${path}" must be a JSON array of { criterion_id, verdict }`,
    );
  }
  const validVerdicts = new Set(["yes", "no", "unsure"]);
  const judgments = raw.map((row, i) => {
    const r = row as { criterion_id?: unknown; verdict?: unknown };
    if (
      typeof r.criterion_id !== "string" ||
      typeof r.verdict !== "string" ||
      !validVerdicts.has(r.verdict)
    ) {
      throw new Error(
        `--regression-baseline: entry ${i} in "${path}" needs a string criterion_id and a verdict of yes|no|unsure`,
      );
    }
    return {
      criterion_id: r.criterion_id,
      verdict: r.verdict as JudgmentResult["verdict"],
      confidence: 1,
      reasoning: "loaded from --regression-baseline",
      method: "judge" as const,
    };
  });
  return { judgments, sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
}

/**
 * One console line for an eval that has lost (or may have lost) its headroom.
 * `headroom` itself is the normal case and is not printed.
 */
export function formatHeadroom(h: HeadroomAssessment): string {
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  const rate = h.pass_rate === null ? "n/a" : pct(h.pass_rate);
  const ceiling = `${pct(h.ceiling)} (${h.ceiling_source})`;
  switch (h.status) {
    case "saturated":
      return `Eval saturated: ${h.passed}/${h.trials} criteria passed (${rate}) at or above the ${ceiling} ceiling; it cannot show that a change helped`;
    case "near_ceiling":
      return `Eval near ceiling: ${h.passed}/${h.trials} criteria passed (${rate}); the 95% interval reaches the ${ceiling} ceiling`;
    case "no_data":
      return "Eval headroom unknown: no criteria were scored";
    default:
      return `Eval has headroom: ${h.passed}/${h.trials} criteria passed (${rate}) below the ${ceiling} ceiling`;
  }
}
