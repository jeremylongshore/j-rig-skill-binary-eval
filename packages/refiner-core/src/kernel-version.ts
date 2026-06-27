/**
 * Kernel-bump propagation — consumed-kernel-version contract and
 * re-baseline-superseded trigger (bead s58e).
 *
 * A refiner behavioral eval baseline is only valid against the kernel version
 * it was measured on. When `@intentsolutions/core` bumps, any baseline
 * measured against the old kernel version is superseded — a stale baseline
 * MUST NOT be cited as current evidence by the `skill-refiner-pass/v1`
 * predicate downstream.
 *
 * This module provides:
 *   1. `CONSUMED_KERNEL_VERSION` — the kernel version `@intentsolutions/refiner-core`
 *      was built and tested against (updated in lockstep with the dep bump).
 *   2. `BaselineKernelRef` — a typed record that attaches the kernel version
 *      to a baseline (extends the EvalSetRef provenance concept).
 *   3. `isBaselineSupersededByKernel()` — pure predicate; returns superseded=true
 *      when `currentKernelVersion > baselineKernelVersion` (semver numeric tuple
 *      comparison, no external dep — consistent with the kernel's own approach).
 *   4. `SupersededBaselineRecord` — the flagged record emitted when a kernel
 *      bump is detected; carries from→to versions for audit provenance. Does NOT
 *      call `Date.now()`; callers inject any provenance timestamp they hold.
 *
 * Design notes:
 *   - `@intentsolutions/core` deliberately avoids a `semver` dep. We match that
 *     posture here: version ordering uses a minimal inline tuple compare over
 *     the three numeric major.minor.patch components, which is sufficient for
 *     the supersession predicate (we only need "strictly newer"). Pre-release
 *     and build-metadata suffixes are intentionally ignored — the kernel only
 *     ships release versions in `dependencies`.
 *   - The peerDependency declaration (package.json `peerDependencies`) makes the
 *     consumed-kernel-version CONTRACT explicit to the host application. The
 *     `dependencies` field retains the exact pin so the monorepo build is
 *     hermetic; the two live in parallel (dep/peerDep duality).
 *
 * Sources:
 *   - Bead s58e: refiner kernel-bump propagation
 *   - DR-028 P0-RATIFY-1: behavioral baseline is eval-set-pinned; by extension
 *     it is also kernel-version-pinned (schema/validator surface is part of the
 *     measurement context)
 *   - bead 99oc (judge-version pinning): structural analog in the judge layer
 */

// ── 1. Consumed kernel version ────────────────────────────────────────────────

/**
 * The `@intentsolutions/core` version that `@intentsolutions/refiner-core` was built and
 * validated against. **Must be updated in lockstep whenever the kernel dep is
 * bumped** (both in `package.json` and here). The string is the source of truth
 * for `isBaselineSupersededByKernel()` comparisons at runtime.
 */
export const CONSUMED_KERNEL_VERSION = "0.9.0" as const;

// ── 2. BaselineKernelRef ──────────────────────────────────────────────────────

/**
 * Records the kernel version a baseline measurement was taken against.
 *
 * Attach this to any baseline record (ScoreRecord, EvalSetRef, or a wrapper
 * that groups them) to make the kernel-version provenance explicit. When the
 * host later checks `isBaselineSupersededByKernel()`, it passes
 * `baselineKernelRef.kernelVersion` as the `baselineKernelVersion` argument.
 *
 * The `kernelVersion` string follows semver notation, e.g. `"0.8.0"`.
 */
export interface BaselineKernelRef {
  /**
   * The `@intentsolutions/core` version that was active when the baseline
   * measurement was recorded. Typically equals `CONSUMED_KERNEL_VERSION` at
   * the time of measurement; becomes stale when the kernel bumps.
   */
  readonly kernelVersion: string;
}

// ── 3. Version comparison (inline, no external dep) ──────────────────────────

/**
 * Parse a semver string `"MAJOR.MINOR.PATCH[...]"` into a numeric tuple.
 * Pre-release / build-metadata suffixes on PATCH are ignored — we only need
 * the three numeric components for the supersession check.
 *
 * Returns `[0, 0, 0]` for any string that does not start with three numeric
 * dot-separated components, treating malformed versions as "zero" (safe-fail:
 * an unknown version is never "newer", so callers should treat a malformed
 * current version as not-superseded and flag the parse failure upstream).
 *
 * @internal Exported for unit-testing only; not part of the public API surface.
 */
export function parseVersionTuple(version: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return [0, 0, 0];
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/**
 * Compare two semver strings. Returns:
 *   -  1 when `a > b`
 *   -  0 when `a === b` (by major.minor.patch numeric components)
 *   - -1 when `a < b`
 *
 * @internal Exported for unit-testing only; not part of the public API surface.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [aMaj, aMin, aPat] = parseVersionTuple(a);
  const [bMaj, bMin, bPat] = parseVersionTuple(b);

  if (aMaj !== bMaj) return aMaj > bMaj ? 1 : -1;
  if (aMin !== bMin) return aMin > bMin ? 1 : -1;
  if (aPat !== bPat) return aPat > bPat ? 1 : -1;
  return 0;
}

// ── 4. Supersession predicate ─────────────────────────────────────────────────

/**
 * Returns `true` when `currentKernelVersion` is strictly newer (by semver
 * numeric major.minor.patch ordering) than `baselineKernelVersion`.
 *
 * A newer kernel means the schema/validator surface has changed; the baseline
 * measurement was taken against a different artifact surface and MUST be treated
 * as superseded.
 *
 * Returns `false` when the versions are equal (baseline is current) or when the
 * current version is older (should not happen in practice, but is safe: if
 * somehow current < baseline, the baseline remains valid against a newer surface
 * it was never tested on — the safer direction is to keep it valid).
 *
 * @param baselineKernelVersion - The kernel version recorded on the baseline
 *   (from `BaselineKernelRef.kernelVersion`).
 * @param currentKernelVersion  - The kernel version currently in use.
 *   Pass `CONSUMED_KERNEL_VERSION` for a production check; tests may inject
 *   any string.
 */
export function isBaselineSupersededByKernel(
  baselineKernelVersion: string,
  currentKernelVersion: string,
): boolean {
  return compareVersions(currentKernelVersion, baselineKernelVersion) === 1;
}

// ── 5. SupersededBaselineRecord ───────────────────────────────────────────────

/**
 * Emitted when a kernel bump makes a baseline stale.
 *
 * Carry this record alongside the original baseline so downstream evidence emit
 * can refuse to cite the baseline as current evidence. The `supersededAt`
 * field accepts any provenance timestamp the caller holds — this library does
 * NOT call `Date.now()` (no I/O, no side effects, deterministic by construction).
 *
 * Typical use:
 * ```ts
 * if (isBaselineSupersededByKernel(baseline.kernelRef.kernelVersion, CONSUMED_KERNEL_VERSION)) {
 *   const record: SupersededBaselineRecord = {
 *     baselineKernelVersion: baseline.kernelRef.kernelVersion,
 *     currentKernelVersion: CONSUMED_KERNEL_VERSION,
 *     supersededAt: new Date().toISOString(),   // caller injects time
 *   };
 *   // route to a "re-baseline required" queue; do NOT cite baseline as evidence
 * }
 * ```
 */
export interface SupersededBaselineRecord {
  /**
   * The kernel version the baseline was originally measured against.
   * This is the "from" side of the bump.
   */
  readonly baselineKernelVersion: string;
  /**
   * The kernel version currently consumed by `@intentsolutions/refiner-core`.
   * This is the "to" side of the bump.
   */
  readonly currentKernelVersion: string;
  /**
   * Provenance timestamp (ISO-8601 rfc3339 string) injected by the caller.
   * The library does NOT call `Date.now()` — the caller owns time.
   */
  readonly supersededAt: string;
}

/**
 * Build a `SupersededBaselineRecord` from the two kernel versions plus a
 * caller-supplied timestamp. Validates that `currentKernelVersion` is indeed
 * newer; throws if called when the predicate would return false.
 *
 * @throws {Error} if `currentKernelVersion` is not strictly newer than
 *   `baselineKernelVersion` — a programming error (call after checking the
 *   predicate, not before).
 */
export function makeSupersededBaselineRecord(
  baselineKernelVersion: string,
  currentKernelVersion: string,
  supersededAt: string,
): SupersededBaselineRecord {
  if (!isBaselineSupersededByKernel(baselineKernelVersion, currentKernelVersion)) {
    throw new Error(
      `makeSupersededBaselineRecord: currentKernelVersion "${currentKernelVersion}" is not strictly newer than baselineKernelVersion "${baselineKernelVersion}" — check isBaselineSupersededByKernel() before calling`,
    );
  }
  return { baselineKernelVersion, currentKernelVersion, supersededAt };
}
