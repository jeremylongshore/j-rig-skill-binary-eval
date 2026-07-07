/**
 * Rollout recommendation.
 */
export type RolloutDecision = "ship" | "warn" | "block" | "obsolete_review";

/**
 * A regression detected between two runs.
 */
export interface Regression {
  criterion_id: string;
  previous_verdict: "yes" | "no";
  current_verdict: "yes" | "no" | "unsure";
  is_sacred: boolean;
}

/**
 * Baseline comparison result for a single criterion.
 */
export interface BaselineComparison {
  criterion_id: string;
  with_skill: "yes" | "no" | "unsure";
  without_skill: "yes" | "no" | "unsure";
  skill_adds_value: boolean;
}

/**
 * Aggregated score for a run.
 */
export interface ScoreCard {
  total_criteria: number;
  passed: number;
  failed: number;
  unsure: number;
  blocker_failures: number;
  sacred_regressions: number;
  pass_rate: number;
  /**
   * ADDITIVE (stability gate): blocker "no" verdicts whose multi-sample judge
   * agreement fell below the spec's `min_blocker_agreement` threshold. These
   * still count in `failed` (the majority said no) but NOT in
   * `blocker_failures` — a verdict too unstable to reproduce is too unstable
   * to BLOCK (or sign) on, so it downgrades to a warning. Optional so
   * hand-built ScoreCard literals (tests, external callers) stay valid.
   */
  unstable_blocker_failures?: number;
}

/**
 * Advisory adoption summary attached to a launch report (ISEDC DR-103 D4 B4.2).
 *
 * The adoption signal (deterministic time-decay; computed in
 * `@intentsolutions/refiner-core` `adoption.ts`) joins the baseline-value flag
 * with decayed usage into one of five advisory verdicts. Per DR-103 D4 the
 * `RolloutDecision` union is NOT mutated — the nuance rides this ADDITIVE, opt-in
 * field instead, so every existing exhaustive `switch` over `RolloutDecision`
 * stays intact.
 *
 * It is **advisory-and-deprecate-only** (DR-103 D4 B4.3): it NEVER promotes a
 * skill and never overrides the deterministic `accept()` / `decideRollout()` gate,
 * which stays the shipping authority. A `thresholds_provisional: true` summary
 * MUST NOT be treated as load-bearing on a production rollout (DR-103 D5 B5.2).
 *
 * This type is intentionally self-contained (no import from refiner-core, to avoid
 * a package cycle); the refiner's richer `AdoptionVerdict` is structurally
 * assignable to it.
 */
export interface AdoptionVerdictSummary {
  /** Joined advisory verdict (keep | watch | deprecate_review | obsolete_review | hold). */
  readonly verdict: "keep" | "watch" | "deprecate_review" | "obsolete_review" | "hold";
  /** Decayed cross-tenant adoption rate (0..1), or null when evidence was insufficient. */
  readonly decayedRate: number | null;
  /** `true` ⇒ thresholds were provisional / not back-tested — NOT load-bearing. */
  readonly thresholdsProvisional: boolean;
}

/**
 * Launch report — the canonical rollout recommendation artifact.
 */
export interface LaunchReport {
  skill_name: string;
  timestamp: string;
  decision: RolloutDecision;
  score: ScoreCard;
  regressions: Regression[];
  baseline: BaselineComparison[];
  blockers: string[];
  warnings: string[];
  reasoning: string;
  /**
   * OPTIONAL advisory adoption summary (DR-103 D4 B4.2). Present only when the
   * caller computed an adoption verdict and opted in; absent otherwise. Consumers
   * that don't understand adoption ignore it; the `decision` field above remains
   * the authoritative rollout call.
   */
  adoptionVerdict?: AdoptionVerdictSummary;
}
