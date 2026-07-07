/**
 * Cost meter — per-attempt token usage, per-accept rollup, and hard-cap
 * quarantine routing for the Skill Refiner pipeline.
 *
 * ## Design contract
 *
 * This module is I/O-free by construction: it records usage, applies budget
 * policies, and emits typed decisions — it never calls a model or touches the
 * filesystem. The adapter layer (`@intentsolutions/refiner`) feeds real token counts
 * produced by the Anthropic API; tests feed deterministic stubs.
 *
 * ## Key types
 *
 * - {@link ModelUsage}      — prompt + completion token counts for one call.
 * - {@link AttemptRecord}   — one propose() attempt with its usage + outcome.
 * - {@link BudgetConfig}    — per-skill or per-run token / attempt ceilings.
 * - {@link CostMeter}       — stateful accumulator: record attempts, query rollup.
 * - {@link QuarantineRecord} — emitted when a hard cap fires; never silently dropped.
 * - {@link BudgetDecision}  — ok-to-continue vs. quarantine-with-reason.
 *
 * ## Hard-cap semantics
 *
 * When a cap fires (token ceiling OR attempt ceiling), the work is NOT silently
 * dropped — it is routed to a quarantine queue as a {@link QuarantineRecord}
 * carrying the reason, the accumulated usage, and the skill that triggered the
 * cap. The pipeline MUST check {@link CostMeter.checkBudget} before each attempt
 * and stop if `{ continue: false }` is returned.
 *
 * Bead: bd_000-projects-jqam
 * Plan: intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md
 */

import type { SkillDocHash } from "./types.js";

// ---------------------------------------------------------------------------
// 1. Token usage shape (returned by the RefinerModel seam)
// ---------------------------------------------------------------------------

/**
 * Token counts for a single model completion (one propose() call).
 * Both fields are non-negative integers; 0 is valid for cached completions.
 */
export interface ModelUsage {
  /** Input tokens sent to the model for this completion. */
  readonly promptTokens: number;
  /** Output tokens produced by the model for this completion. */
  readonly completionTokens: number;
}

/** Total tokens (promptTokens + completionTokens). */
export function totalTokens(usage: ModelUsage): number {
  return usage.promptTokens + usage.completionTokens;
}

// ---------------------------------------------------------------------------
// 2. Per-attempt record
// ---------------------------------------------------------------------------

/** Whether a propose() attempt produced an accepted or rejected proposal. */
export type AttemptOutcome = "accepted" | "rejected" | "pending";

/**
 * An immutable record of one propose() attempt: the skill it ran against,
 * the token usage incurred, and whether the resulting proposal was accepted.
 */
export interface AttemptRecord {
  /** Content address of the skill doc this attempt ran against. */
  readonly skillHash: SkillDocHash;
  /** Model that produced the completion for this attempt. */
  readonly modelId: string;
  /** Token counts from this attempt's model completion. */
  readonly usage: ModelUsage;
  /** "accepted" once accept() passes, "rejected" if not, "pending" if undecided. */
  readonly outcome: AttemptOutcome;
}

// ---------------------------------------------------------------------------
// 3. Budget configuration
// ---------------------------------------------------------------------------

/**
 * Hard-cap ceilings for the cost meter.
 *
 * Both `maxTotalTokens` and `maxAttempts` are optional; omit either to leave
 * that dimension uncapped. When a ceiling is exceeded, a {@link QuarantineRecord}
 * is emitted and the pipeline must stop attempting on that item.
 *
 * Recommended placement: pass per-skill config down from the orchestrator
 * (`@intentsolutions/refiner`). Core ships only the shape; defaults are caller's choice.
 */
export interface BudgetConfig {
  /**
   * Maximum combined (prompt + completion) tokens across all attempts for
   * one skill refinement run. When exceeded, the run is quarantined.
   */
  readonly maxTotalTokens?: number;
  /**
   * Maximum number of propose() attempts for one skill refinement run.
   * Prevents runaway loops when the strategy keeps proposing rejected edits.
   */
  readonly maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// 4. Quarantine — the over-budget routing record
// ---------------------------------------------------------------------------

/** Machine-readable reason a skill was routed to the quarantine queue. */
export type QuarantineReason =
  /** Accumulated tokens across all attempts exceeded `BudgetConfig.maxTotalTokens`. */
  | "token-ceiling-exceeded"
  /** Number of propose() attempts exceeded `BudgetConfig.maxAttempts`. */
  | "attempt-ceiling-exceeded";

/**
 * Emitted when a hard cap fires. Never silently dropped.
 *
 * The orchestrator is expected to collect these in a quarantine queue so the
 * Evidence Report can surface over-budget items for human review. At minimum,
 * the record carries: which skill, why it was quarantined, how much was spent,
 * and how many attempts were made.
 */
export interface QuarantineRecord {
  /** Content address of the skill doc that triggered the quarantine. */
  readonly skillHash: SkillDocHash;
  /** Machine-readable reason. */
  readonly reason: QuarantineReason;
  /** Usage accumulated at the point the cap fired (NOT retroactively adjusted). */
  readonly usageAtCapFire: ModelUsage;
  /** Number of attempts recorded when the cap fired. */
  readonly attemptsAtCapFire: number;
  /** The budget config that was in effect when the cap fired. */
  readonly budget: BudgetConfig;
}

// ---------------------------------------------------------------------------
// 5. Budget decision (ok vs. quarantine)
// ---------------------------------------------------------------------------

/**
 * The result of {@link CostMeter.checkBudget}: either the pipeline may
 * continue, or it is quarantined with a typed record.
 */
export type BudgetDecision =
  { readonly continue: true } | { readonly continue: false; readonly quarantine: QuarantineRecord };

// ---------------------------------------------------------------------------
// 6. Per-accept rollup
// ---------------------------------------------------------------------------

/**
 * Aggregated token usage across the attempts that led to an accepted proposal.
 *
 * "Per-accept rollup" answers: "how many tokens did it cost, in total, to
 * produce the one accepted edit for this skill?" It sums only the attempts
 * whose outcome is "accepted" or "pending" that preceded the accepted outcome
 * — i.e. it accumulates across ALL attempts recorded on the meter up to (and
 * including) the accepted one, since rejected proposals are genuine cost too.
 *
 * To compute a rollup scoped to only the accepted attempts, use
 * {@link CostMeter.acceptRollup}.
 */
export interface AcceptRollup {
  /** Total tokens spent across ALL recorded attempts (including rejected). */
  readonly totalTokens: number;
  /** Breakdown: total prompt tokens across all attempts. */
  readonly totalPromptTokens: number;
  /** Breakdown: total completion tokens across all attempts. */
  readonly totalCompletionTokens: number;
  /** Number of attempts recorded (accepted + rejected). */
  readonly totalAttempts: number;
  /** Number of attempts whose outcome is "accepted". */
  readonly acceptedAttempts: number;
}

// ---------------------------------------------------------------------------
// 7. CostMeter — the stateful accumulator
// ---------------------------------------------------------------------------

/**
 * Stateful accumulator for one skill refinement run.
 *
 * ## Usage pattern
 *
 * ```ts
 * const meter = createCostMeter(skillHash, budget);
 *
 * // Before each attempt:
 * const decision = meter.checkBudget();
 * if (!decision.continue) {
 *   quarantineQueue.push(decision.quarantine);
 *   break;
 * }
 *
 * // After a model call, record the attempt:
 * meter.record({ skillHash, modelId, usage, outcome: "rejected" });
 *
 * // After accept() passes, mark it accepted:
 * meter.record({ skillHash, modelId, usage, outcome: "accepted" });
 *
 * // At the end of the run:
 * const rollup = meter.acceptRollup();
 * ```
 *
 * **The meter is per-run-per-skill.** For multi-skill pipelines the orchestrator
 * creates one meter per skill and collects the rollups + any quarantine records.
 */
export interface CostMeter {
  /**
   * The skill doc hash this meter tracks (set at construction; read-only).
   */
  readonly skillHash: SkillDocHash;

  /**
   * The budget config in effect for this run (set at construction; read-only).
   */
  readonly budget: BudgetConfig;

  /**
   * Record one propose() attempt. Call this after every model completion,
   * whether the resulting proposal was accepted or not.
   *
   * Attempts are appended in call order; the meter is append-only.
   */
  record(attempt: AttemptRecord): void;

  /**
   * Check whether the pipeline may continue based on accumulated usage vs. the
   * configured budget. Call this BEFORE each attempt — if it returns
   * `{ continue: false }`, push the quarantine record to the queue and stop.
   *
   * The check is "would starting the NEXT attempt violate the ceiling given what
   * has already been spent?" — it does NOT subtract the current attempt's cost
   * because that cost is not yet known.
   *
   * Returns `{ continue: true }` when all caps are satisfied. Returns
   * `{ continue: false, quarantine }` when any cap is exceeded. The first cap
   * that fires determines the `QuarantineReason`.
   */
  checkBudget(): BudgetDecision;

  /**
   * Compute the per-accept rollup: total tokens + attempt counts across all
   * recorded attempts. This is defined for any run regardless of whether any
   * attempt was accepted — it is the cost incurred so far (callers use the
   * `acceptedAttempts` count to detect the "no accepted yet" case).
   */
  acceptRollup(): AcceptRollup;

  /**
   * Read-only snapshot of recorded attempts (in insertion order).
   */
  readonly attempts: readonly AttemptRecord[];
}

// ---------------------------------------------------------------------------
// 8. Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link CostMeter} for one skill refinement run.
 *
 * @param skillHash The content address of the skill being refined.
 * @param budget    The hard-cap ceilings for this run. Pass `{}` for no caps.
 */
export function createCostMeter(skillHash: SkillDocHash, budget: BudgetConfig): CostMeter {
  const _attempts: AttemptRecord[] = [];

  function currentUsage(): ModelUsage {
    return _attempts.reduce(
      (acc, a) => ({
        promptTokens: acc.promptTokens + a.usage.promptTokens,
        completionTokens: acc.completionTokens + a.usage.completionTokens,
      }),
      { promptTokens: 0, completionTokens: 0 },
    );
  }

  return {
    skillHash,
    budget,

    get attempts(): readonly AttemptRecord[] {
      return _attempts;
    },

    record(attempt: AttemptRecord): void {
      _attempts.push(attempt);
    },

    checkBudget(): BudgetDecision {
      const usageSoFar = currentUsage();
      const attemptCount = _attempts.length;

      // Attempt ceiling check (cheaper): have we already used all allowed attempts?
      if (budget.maxAttempts !== undefined && attemptCount >= budget.maxAttempts) {
        return {
          continue: false,
          quarantine: {
            skillHash,
            reason: "attempt-ceiling-exceeded",
            usageAtCapFire: usageSoFar,
            attemptsAtCapFire: attemptCount,
            budget,
          },
        };
      }

      // Token ceiling check: have accumulated tokens already exceeded the ceiling?
      if (budget.maxTotalTokens !== undefined) {
        const spent = totalTokens(usageSoFar);
        if (spent >= budget.maxTotalTokens) {
          return {
            continue: false,
            quarantine: {
              skillHash,
              reason: "token-ceiling-exceeded",
              usageAtCapFire: usageSoFar,
              attemptsAtCapFire: attemptCount,
              budget,
            },
          };
        }
      }

      return { continue: true };
    },

    acceptRollup(): AcceptRollup {
      const usageSoFar = currentUsage();
      const acceptedAttempts = _attempts.filter((a) => a.outcome === "accepted").length;
      return {
        totalTokens: totalTokens(usageSoFar),
        totalPromptTokens: usageSoFar.promptTokens,
        totalCompletionTokens: usageSoFar.completionTokens,
        totalAttempts: _attempts.length,
        acceptedAttempts,
      };
    },
  };
}
