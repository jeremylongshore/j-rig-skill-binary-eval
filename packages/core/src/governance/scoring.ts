import type { Criterion } from "../schemas/criterion.js";
import type { JudgmentResult } from "../judgment/types.js";
import type {
  ScoreCard,
  RolloutDecision,
  LaunchReport,
  Regression,
  BaselineComparison,
} from "./types.js";

/**
 * Compute a score card from judgment results.
 */
export function computeScoreCard(
  results: JudgmentResult[],
  criteria: Criterion[],
  regressions: Regression[] = [],
): ScoreCard {
  const criteriaMap = new Map(criteria.map((c) => [c.id, c]));

  let passed = 0,
    failed = 0,
    unsure = 0,
    blockerFailures = 0;

  for (const r of results) {
    if (r.verdict === "yes") passed++;
    else if (r.verdict === "no") {
      failed++;
      const criterion = criteriaMap.get(r.criterion_id);
      if (criterion?.blocker) blockerFailures++;
    } else {
      unsure++;
    }
  }

  const sacredRegressions = regressions.filter((r) => r.is_sacred).length;

  return {
    total_criteria: results.length,
    passed,
    failed,
    unsure,
    blocker_failures: blockerFailures,
    sacred_regressions: sacredRegressions,
    pass_rate: results.length > 0 ? passed / results.length : 0,
  };
}

/**
 * Determine the rollout decision based on score card and baseline.
 *
 * Decision rules (non-negotiable):
 * - Any blocker failure → BLOCK
 * - Any sacred regression → BLOCK
 * - Obsolete candidate → OBSOLETE_REVIEW
 * - Any non-blocker failures or unsure → WARN
 * - All pass → SHIP
 */
export function decideRollout(score: ScoreCard, isObsolete: boolean = false): RolloutDecision {
  if (score.blocker_failures > 0) return "block";
  if (score.sacred_regressions > 0) return "block";
  if (isObsolete) return "obsolete_review";
  if (score.failed > 0 || score.unsure > 0) return "warn";
  return "ship";
}

/**
 * Build a complete launch report.
 */
export function buildLaunchReport(
  skillName: string,
  score: ScoreCard,
  regressions: Regression[],
  baseline: BaselineComparison[],
  isObsolete: boolean,
): LaunchReport {
  const decision = decideRollout(score, isObsolete);

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (score.blocker_failures > 0) {
    blockers.push(`${score.blocker_failures} blocker criteria failed`);
  }
  if (score.sacred_regressions > 0) {
    blockers.push(`${score.sacred_regressions} sacred regressions detected`);
  }
  if (isObsolete) {
    warnings.push("Skill may be obsolete — baseline matches skill on most criteria");
  }
  if (score.unsure > 0) {
    warnings.push(`${score.unsure} criteria could not be judged (unsure)`);
  }
  if (score.failed > 0 && score.blocker_failures === 0) {
    warnings.push(`${score.failed} non-blocker criteria failed`);
  }

  const reasoning =
    decision === "ship"
      ? `All ${score.total_criteria} criteria passed. Ready to ship.`
      : decision === "block"
        ? `Release blocked: ${blockers.join("; ")}`
        : decision === "obsolete_review"
          ? "Skill flagged for obsolete review — baseline model matches skill performance."
          : `${score.passed}/${score.total_criteria} criteria passed with warnings.`;

  return {
    skill_name: skillName,
    timestamp: new Date().toISOString(),
    decision,
    score,
    regressions,
    baseline,
    blockers,
    warnings,
    reasoning,
  };
}
