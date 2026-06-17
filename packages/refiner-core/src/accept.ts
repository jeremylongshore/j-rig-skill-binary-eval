/**
 * The acceptance gate — the durable contribution of the Skill Refiner (AC-7).
 *
 * This is a PURE predicate. It implements DR-028 (Session 7) P0-RATIFY-1 exactly:
 *
 *   accept() = candidate is Pareto-dominant on the kernel-pinned `behavioral`
 *              dimension AND non-regressing on all other named dimensions, with a
 *              statistical-significance threshold T at α = 0.05.
 *
 *   Tie-break (Kleppmann F-MK-6 + CSO normative-spec): if neither version
 *   Pareto-dominates the other, the candidate is REJECTED and added to the
 *   rejected-edit buffer with reason `pareto-incomparable`.
 *
 * "Pareto-dominant on behavioral + non-regressing on others" is the partial
 * order: v2 dominates v1 iff
 *     (1) v2.behavioral is SIGNIFICANTLY greater than v1.behavioral (the strict
 *         improvement, tested at α), AND
 *     (2) for every other named dimension d, v2[d] does NOT regress v1[d]
 *         (a regression is a SIGNIFICANT decrease at α; noise within α is not a
 *         regression).
 *
 * If (1) fails: reject `no-behavioral-improvement`.
 * If (1) holds but (2) fails on some dim: the two are Pareto-incomparable
 *   (candidate gained behavioral but lost something else) → reject
 *   `pareto-incomparable` per the DR-028 tie-break (with the regressed dim also
 *   surfaced via `regressed-named-dimension` when behavioral itself didn't move).
 *
 * The significance test is a two-sample z-test on the difference of means using
 * the variance + sample count carried on each ScoreDimension. A deterministic
 * dimension (variance 0) reduces to an exact comparison, which is the correct
 * limiting behavior.
 */

import type { ScoreRecord, ScoreDimension, AcceptResult, RejectionReason } from "./types.js";
import { BEHAVIORAL_DIMENSION, DEFAULT_ALPHA } from "./types.js";

/**
 * Two-sided z critical values for the alpha levels we support. We avoid pulling
 * in a stats dependency: the gate only needs a one-sided test at the configured
 * alpha, so we map alpha -> z(1 - alpha) for the common levels and fall back to
 * a rational approximation otherwise.
 */
const Z_BY_ALPHA: Readonly<Record<string, number>> = {
  "0.1": 1.2815515594, // z(0.90)
  "0.05": 1.6448536269, // z(0.95)
  "0.025": 1.9599639845, // z(0.975)
  "0.01": 2.326347874, // z(0.99)
};

/**
 * One-sided normal critical value z(1 - alpha). Uses an exact table for common
 * levels, else the Acklam rational approximation of the inverse normal CDF.
 */
function zCritical(alpha: number): number {
  const key = String(alpha);
  if (key in Z_BY_ALPHA) return Z_BY_ALPHA[key];
  return inverseNormalCdf(1 - alpha);
}

/** Acklam's inverse-normal-CDF approximation (abs error < 1.15e-9). */
function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new RangeError(`probability out of (0,1): ${p}`);
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

/** Pooled standard error of (a.value - b.value) for two independent estimates. */
function standardError(a: ScoreDimension, b: ScoreDimension): number {
  const va = a.n > 0 ? a.variance / a.n : 0;
  const vb = b.n > 0 ? b.variance / b.n : 0;
  return Math.sqrt(va + vb);
}

/**
 * Significant improvement test: is `candidate` significantly GREATER than
 * `baseline` at the given alpha? Deterministic dims (SE 0) reduce to a strict
 * `>` comparison.
 */
export function isSignificantImprovement(
  candidate: ScoreDimension,
  baseline: ScoreDimension,
  alpha: number = DEFAULT_ALPHA,
): boolean {
  const diff = candidate.value - baseline.value;
  if (diff <= 0) return false;
  const se = standardError(candidate, baseline);
  if (se === 0) return diff > 0; // deterministic: any positive delta is significant
  return diff / se >= zCritical(alpha);
}

/**
 * Significant regression test: is `candidate` significantly LESS than `baseline`
 * at the given alpha? Noise within alpha is NOT a regression (non-regression
 * tolerates statistically-insignificant dips). Deterministic dims reduce to `<`.
 */
export function isSignificantRegression(
  candidate: ScoreDimension,
  baseline: ScoreDimension,
  alpha: number = DEFAULT_ALPHA,
): boolean {
  const diff = candidate.value - baseline.value;
  if (diff >= 0) return false;
  const se = standardError(candidate, baseline);
  if (se === 0) return diff < 0; // deterministic: any negative delta regresses
  return -diff / se >= zCritical(alpha);
}

/**
 * The acceptance gate. Returns `{ accepted: true }` only when the candidate
 * Pareto-dominates the baseline per DR-028 P0-RATIFY-1; otherwise a reason-tagged
 * rejection for the audit buffer.
 *
 * @param baseline  ScoreRecord of the current-best skill version (v1).
 * @param candidate ScoreRecord of the proposed skill version (v2).
 * @param alpha     Significance level (default 0.05).
 */
export function accept(
  baseline: ScoreRecord,
  candidate: ScoreRecord,
  alpha: number = DEFAULT_ALPHA,
): AcceptResult {
  // Records must be comparable: same skill lineage is NOT required (the hashes
  // differ by construction — v1 vs v2), but they MUST be scored against the same
  // eval set, or the comparison is meaningless.
  if (baseline.evalSet !== candidate.evalSet) {
    return reject("incomparable-records");
  }

  // (1) Strict, significant improvement on the kernel-pinned behavioral dim.
  const behavioralImproved = isSignificantImprovement(
    candidate.behavioral,
    baseline.behavioral,
    alpha,
  );

  // (2) Non-regression on every other named dimension.
  const regressedDim = findRegressedDimension(baseline, candidate, alpha);

  if (behavioralImproved && regressedDim === null) {
    return { accepted: true };
  }

  // Behavioral improved but a non-behavioral dim regressed → the two versions are
  // Pareto-incomparable (each is better on a different axis). DR-028 tie-break.
  if (behavioralImproved && regressedDim !== null) {
    return reject("pareto-incomparable");
  }

  // Behavioral did NOT significantly improve. If something also regressed, the
  // candidate is strictly worse-or-equal on behavioral and worse on another dim —
  // surface the named regression; otherwise the gate failed on behavioral alone.
  if (!behavioralImproved && regressedDim !== null) {
    return reject("regressed-named-dimension");
  }
  return reject("no-behavioral-improvement");
}

/**
 * Returns the name of the first non-behavioral named dimension that significantly
 * regresses (candidate < baseline at alpha), or null if none regress. A dimension
 * present in the baseline but absent in the candidate is treated as a regression
 * (the candidate dropped a measured guarantee).
 */
function findRegressedDimension(
  baseline: ScoreRecord,
  candidate: ScoreRecord,
  alpha: number,
): string | null {
  for (const name of Object.keys(baseline.dimensions)) {
    if (name === BEHAVIORAL_DIMENSION) continue;
    const base = baseline.dimensions[name];
    const cand = candidate.dimensions[name];
    if (cand === undefined) {
      // The candidate stopped measuring a dimension the baseline guaranteed.
      return name;
    }
    if (isSignificantRegression(cand, base, alpha)) {
      return name;
    }
  }
  return null;
}

function reject(reason: RejectionReason): AcceptResult {
  return { accepted: false, reason };
}
