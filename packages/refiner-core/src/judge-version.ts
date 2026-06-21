/**
 * Judge-version pinning — consumed-judge-version contract and
 * vNext-baseline trigger (bead 99oc / D28-PHASE-A0).
 *
 * The D28-PHASE-A0 null-hypothesis baseline records which LLM judge version
 * produced its verdicts. A baseline's scores are only comparable to other
 * baselines produced by the SAME judge — when the judge version changes, the
 * old baseline is superseded and a fresh (vNext) baseline MUST be captured
 * against the new judge. This enables explicit old-vs-new baseline comparison
 * rather than silent replacement.
 *
 * This module provides:
 *   1. `CONSUMED_JUDGE_VERSION` — the judge model identifier that
 *      `@intentsolutions/refiner-core` was built and validated against. Updated in
 *      lockstep whenever the judge model is intentionally changed.
 *   2. `BaselineJudgeRef` — a typed record that attaches the pinned judge
 *      version to a baseline, making judge provenance explicit.
 *   3. `isBaselineSupersededByJudge()` — pure predicate; returns
 *      superseded=true when the current judge version DIFFERS from the
 *      baseline's pinned judge version. Judge versions are opaque string
 *      identifiers (e.g. `"claude-sonnet-4-5"` or `"claude-opus-4-0"`) —
 *      not necessarily semver-ordered — so any change to the identifier
 *      triggers supersession (even a "downgrade"). See Design notes below.
 *   4. `VNextBaselineTrigger` — the record emitted when a judge bump is
 *      detected; carries old→new judge versions + an injected timestamp,
 *      so the old and new baselines can be explicitly compared. Does NOT
 *      call `Date.now()`; callers inject any provenance timestamp they hold.
 *
 * Design notes:
 *   - Judge versions vs kernel versions: `kernel-version.ts` uses semver
 *     ordering ("strictly newer" triggers supersession) because the kernel
 *     follows semver and patch/minor/major bumps have different semantics.
 *     Judge versions are LLM model identifiers — opaque strings whose
 *     ordering is not guaranteed or semantically meaningful for our purposes.
 *     A change from `claude-sonnet-4-5` to `claude-opus-4-0` is a lateral
 *     capability swap, not a version bump; from `claude-sonnet-4-5` to
 *     `claude-sonnet-4-6` is a revision but the identifier form is not
 *     semver. Treating ANY identifier change as supersession is the strictly
 *     correct policy: it forces a fresh vNext baseline whenever the judge
 *     surface changes, regardless of the direction.
 *   - The `CONSUMED_JUDGE_VERSION` string uses the Anthropic model-identifier
 *     form (e.g. `"claude-sonnet-4-5"`). If the project later adopts a
 *     versioned judge that uses semver, replace this module's supersession
 *     predicate with a semver-ordered one and document the change here.
 *   - No external dep: the supersession check is a simple string-equality
 *     test, which needs no libraries. This preserves the zero-external-dep
 *     posture of `kernel-version.ts`.
 *
 * Sources:
 *   - Bead 99oc: Phase A.0 judge-version pinning
 *   - DR-028 P0-RATIFY-1: behavioral baseline is eval-set-pinned; by
 *     extension it is also judge-version-pinned (the LLM judge surface is
 *     part of the measurement context — a different judge model produces
 *     incomparable verdicts)
 *   - D28-PHASE-A0: null-hypothesis baseline bead whose scoring context
 *     requires an explicit judge-version pin
 *   - bead s58e (kernel-version.ts): structural analog in the kernel layer
 */

// ── 1. Consumed judge version ─────────────────────────────────────────────────

/**
 * The LLM judge model identifier that `@intentsolutions/refiner-core` was built and
 * validated against. **Must be updated in lockstep whenever the judge model
 * is intentionally changed** (both here and in any eval spec or config that
 * references the judge model). The string is the source of truth for
 * `isBaselineSupersededByJudge()` comparisons at runtime.
 *
 * The identifier follows the Anthropic model-ID form (e.g.
 * `"claude-sonnet-4-5"`). If a different provider's judge is adopted, use
 * that provider's canonical model-ID string and update this constant.
 */
export const CONSUMED_JUDGE_VERSION = "claude-sonnet-4-5" as const;

// ── 2. BaselineJudgeRef ───────────────────────────────────────────────────────

/**
 * Records the judge version a baseline measurement was produced by.
 *
 * Attach this to any baseline record (ScoreRecord, EvalSetRef, or a wrapper
 * that groups them) to make the judge-version provenance explicit. When the
 * host later checks `isBaselineSupersededByJudge()`, it passes
 * `baselineJudgeRef.judgeVersion` as the `baselineJudgeVersion` argument.
 *
 * The `judgeVersion` string is an opaque model identifier, e.g.
 * `"claude-sonnet-4-5"`. See Design notes in the module header.
 */
export interface BaselineJudgeRef {
  /**
   * The judge model identifier that was active when the baseline verdicts
   * were recorded. Typically equals `CONSUMED_JUDGE_VERSION` at the time of
   * measurement; becomes stale when the judge model changes.
   */
  readonly judgeVersion: string;
}

// ── 3. Supersession predicate ─────────────────────────────────────────────────

/**
 * Returns `true` when `currentJudgeVersion` DIFFERS from
 * `baselineJudgeVersion`.
 *
 * Any change to the judge model identifier means the baseline's verdicts
 * were produced by a different LLM surface and MUST be treated as
 * superseded — the old and new baselines are incomparable. A fresh vNext
 * baseline is required before cross-baseline comparisons are valid.
 *
 * Returns `false` when the identifiers are exactly equal (baseline is
 * current — verdicts remain comparable).
 *
 * Note: Unlike `isBaselineSupersededByKernel()`, which checks "strictly
 * newer" via semver, this predicate uses equality only. Judge versions are
 * opaque identifiers — not semver — so any identifier change triggers
 * supersession regardless of which direction the change goes.
 *
 * @param baselineJudgeVersion - The judge version recorded on the baseline
 *   (from `BaselineJudgeRef.judgeVersion`).
 * @param currentJudgeVersion  - The judge version currently in use.
 *   Pass `CONSUMED_JUDGE_VERSION` for a production check; tests may inject
 *   any string.
 */
export function isBaselineSupersededByJudge(
  baselineJudgeVersion: string,
  currentJudgeVersion: string,
): boolean {
  return baselineJudgeVersion !== currentJudgeVersion;
}

// ── 4. VNextBaselineTrigger ───────────────────────────────────────────────────

/**
 * Emitted when a judge change makes a baseline stale.
 *
 * Carry this record alongside the original (now-superseded) baseline so
 * downstream evidence emit can:
 *   a) refuse to cite the old baseline as current evidence, and
 *   b) queue a vNext baseline run against the new judge for an
 *      explicit old-vs-new comparison.
 *
 * The old baseline is NOT discarded — it is retained for the explicit
 * old-vs-new comparison. The `triggeredAt` field accepts any provenance
 * timestamp the caller holds — this library does NOT call `Date.now()`
 * (no I/O, no side effects, deterministic by construction).
 *
 * Typical use:
 * ```ts
 * if (isBaselineSupersededByJudge(baseline.judgeRef.judgeVersion, CONSUMED_JUDGE_VERSION)) {
 *   const trigger: VNextBaselineTrigger = {
 *     supersededJudgeVersion: baseline.judgeRef.judgeVersion,
 *     currentJudgeVersion: CONSUMED_JUDGE_VERSION,
 *     triggeredAt: new Date().toISOString(),   // caller injects time
 *   };
 *   // retain the OLD baseline + queue a NEW vNext baseline run
 *   // do NOT cite the old baseline as current evidence
 * }
 * ```
 */
export interface VNextBaselineTrigger {
  /**
   * The judge version the old baseline was produced by.
   * This is the "from" side of the judge change.
   */
  readonly supersededJudgeVersion: string;
  /**
   * The judge version currently in use.
   * This is the "to" side of the judge change.
   */
  readonly currentJudgeVersion: string;
  /**
   * Provenance timestamp (ISO-8601 rfc3339 string) injected by the caller.
   * The library does NOT call `Date.now()` — the caller owns time.
   */
  readonly triggeredAt: string;
}

/**
 * Build a `VNextBaselineTrigger` from the two judge versions plus a
 * caller-supplied timestamp. Validates that `currentJudgeVersion` actually
 * differs from `supersededJudgeVersion`; throws if called when the
 * predicate would return false (the baseline is not superseded).
 *
 * @throws {Error} if `currentJudgeVersion === supersededJudgeVersion` —
 *   a programming error (call after checking the predicate, not before).
 */
export function makeVNextBaselineTrigger(
  supersededJudgeVersion: string,
  currentJudgeVersion: string,
  triggeredAt: string,
): VNextBaselineTrigger {
  if (!isBaselineSupersededByJudge(supersededJudgeVersion, currentJudgeVersion)) {
    throw new Error(
      `makeVNextBaselineTrigger: currentJudgeVersion "${currentJudgeVersion}" is identical to supersededJudgeVersion "${supersededJudgeVersion}" — check isBaselineSupersededByJudge() before calling`,
    );
  }
  return { supersededJudgeVersion, currentJudgeVersion, triggeredAt };
}
