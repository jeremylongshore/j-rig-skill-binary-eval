import type { Criterion } from "../schemas/criterion.js";
import type { JudgmentResult } from "../judgment/types.js";
import type {
  ScoreCard,
  RolloutDecision,
  LaunchReport,
  Regression,
  BaselineComparison,
  AdoptionVerdictSummary,
} from "./types.js";

/**
 * Optional, injectable extras for {@link buildLaunchReport}.
 *
 * `now` is the DETERMINISM fix (ISEDC DR-103 D5 B5.1): `buildLaunchReport`
 * historically called `new Date().toISOString()` directly, which made the launch
 * report — the very artifact the adoption signal lands in — non-replayable.
 * Rejecting a non-deterministic bandit (D5) while the host reads the wall clock
 * would be incoherent, so the clock is now INJECTED, mirroring
 * `refiner-core/kernel-version.ts` + `eval-set.ts isRefreshDue`. It stays optional
 * (defaulting to the wall clock) so existing callers keep working; deterministic
 * callers (and every test) pass a fixed `now`.
 */
export interface BuildLaunchReportOptions {
  /**
   * rfc3339 timestamp stamped onto `report.timestamp`. INJECT this for a
   * replayable artifact (DR-103 D5 B5.1). Defaults to `new Date().toISOString()`
   * ONLY for backward-compatible callers that have not yet adopted injection.
   */
  readonly now?: string;
  /**
   * OPTIONAL advisory adoption summary (DR-103 D4 B4.2). When supplied it rides the
   * additive `report.adoptionVerdict` field; the `RolloutDecision` is untouched.
   */
  readonly adoptionVerdict?: AdoptionVerdictSummary;
}

/**
 * Stability options for {@link computeScoreCard} — the noise-robustness gate.
 */
export interface StabilityOptions {
  /**
   * Agreement fraction a MULTI-SAMPLED blocker "no" must reach to count as a
   * release-blocking failure. Below it, the verdict is too unstable to
   * honestly BLOCK (or sign) on — it downgrades to `unstable_blocker_failures`
   * (still `failed`, so the rollout lands on WARN, never a noise-BLOCK and
   * never a false SHIP). Single-call judge results and deterministic results
   * are never downgraded — with one sample there is no stability evidence,
   * so the legacy any-blocker-no → BLOCK rule stands.
   */
  min_blocker_agreement?: number;
}

/**
 * Compute a score card from judgment results.
 */
export function computeScoreCard(
  results: JudgmentResult[],
  criteria: Criterion[],
  regressions: Regression[] = [],
  stability?: StabilityOptions,
): ScoreCard {
  const criteriaMap = new Map(criteria.map((c) => [c.id, c]));
  const threshold = stability?.min_blocker_agreement;

  let passed = 0,
    failed = 0,
    unsure = 0,
    blockerFailures = 0,
    unstableBlockerFailures = 0;

  for (const r of results) {
    if (r.verdict === "yes") passed++;
    else if (r.verdict === "no") {
      failed++;
      const criterion = criteriaMap.get(r.criterion_id);
      if (criterion?.blocker) {
        // Stability gate: only a REPRODUCED blocker "no" blocks. Applies only
        // when the judge actually multi-sampled (samples >= 2) AND the spec
        // opted into a threshold; everything else keeps legacy semantics.
        const unstable =
          threshold !== undefined &&
          r.method === "judge" &&
          typeof r.agreement === "number" &&
          (r.samples ?? 1) >= 2 &&
          r.agreement < threshold;
        if (unstable) unstableBlockerFailures++;
        else blockerFailures++;
      }
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
    unstable_blocker_failures: unstableBlockerFailures,
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
 *
 * Stability note: when the spec opts into `min_blocker_agreement`, a
 * multi-sampled blocker "no" below the threshold never reaches
 * `blocker_failures` (see {@link computeScoreCard}) — it stays in `failed`,
 * so the decision lands on WARN: never a noise-BLOCK, never a false SHIP.
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
 *
 * @param opts - Optional injected extras. Pass `opts.now` (rfc3339) for a
 *   replayable `timestamp` (DR-103 D5 B5.1 — non-waivable for deterministic
 *   callers); pass `opts.adoptionVerdict` to attach the advisory adoption summary
 *   (DR-103 D4 B4.2, additive field). Omitting `opts` preserves the legacy
 *   wall-clock behavior.
 */
export function buildLaunchReport(
  skillName: string,
  score: ScoreCard,
  regressions: Regression[],
  baseline: BaselineComparison[],
  isObsolete: boolean,
  opts: BuildLaunchReportOptions = {},
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
  if ((score.unstable_blocker_failures ?? 0) > 0) {
    warnings.push(
      `${score.unstable_blocker_failures} blocker criteria failed below the agreement ` +
        `stability threshold — unstable verdicts downgraded to warnings, not blockers ` +
        `(re-run with more samples to resolve)`,
    );
  }
  // Unstable blocker failures are already covered by their own warning above —
  // don't double-report them as "non-blocker" failures here.
  const nonBlockerFailures = score.failed - (score.unstable_blocker_failures ?? 0);
  if (nonBlockerFailures > 0 && score.blocker_failures === 0) {
    warnings.push(`${nonBlockerFailures} non-blocker criteria failed`);
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
    // DR-103 D5 B5.1: injected clock for replayability; falls back to wall clock
    // only for legacy callers that have not yet adopted injection.
    timestamp: opts.now ?? new Date().toISOString(),
    decision,
    score,
    regressions,
    baseline,
    blockers,
    warnings,
    reasoning,
    // DR-103 D4 B4.2: additive advisory field; present only when opted in.
    ...(opts.adoptionVerdict !== undefined ? { adoptionVerdict: opts.adoptionVerdict } : {}),
  };
}
