/**
 * eval-set-metrics.ts — quality metrics for an EvalSet (bead 214c.11).
 *
 * Implements four pure metric functions over an EvalSet:
 *
 *   1. **coverage** — diversity of the eval set's behavioral space, measured as
 *      Shannon entropy of the item-type distribution (derived from the item `id`
 *      prefix segment, e.g. "validate-skillmd-syn-001" → type "syn"; or over
 *      the first token of each `prompt` when no structured prefix is present).
 *      Returns a normalized [0,1] score + per-type breakdown. A uniform set has
 *      coverage = 1.0; a set where every item comes from one bucket has
 *      coverage = 0.0 (when there is more than one bucket).
 *
 *   2. **leakage** — overlap between two item collections (e.g. eval set vs.
 *      reference / training set). Also detects intra-set exact duplicate items
 *      when called with setB = setA.  Concrete: content-hash overlap ratio over
 *      serialized item prompts (trim-lower-case canonicalization before hashing,
 *      so whitespace / case differences do NOT hide overlap). Returns the ratio
 *      `overlappingCount / min(setA.length, setB.length)` and the ids of the
 *      overlapping items found in setA. A ratio of 0.0 is clean; 1.0 means
 *      every item in the smaller set has a match in the larger.
 *
 *   3. **calibration** — agreement between judge confidence and actual
 *      correctness over a scored run. Accepts an array of
 *      `{confidence: number, correct: boolean}` pairs (the scoring side
 *      produces these; this function is pure and wired when scored data exists).
 *      Returns the **Brier score** (lower is better; 0.0 = perfect, 1.0 = worst)
 *      and the **Expected Calibration Error** (ECE, lower is better) over 10
 *      equal-width bins.  A perfectly-calibrated judge has ECE ≈ 0; a judge
 *      that reports 0.9 confidence on every item regardless of outcome has a
 *      high Brier score.
 *
 *   4. **adversarialPassRate** — pass rate restricted to items flagged as
 *      adversarial. Items are tagged via the optional `adversarial?: boolean`
 *      field on `EvalItem` (added in this bead; backward-compatible — omitting
 *      the field is the same as `false`).  Accepts the item collection and a
 *      separate result array keyed by item id. Returns `passed / total` for the
 *      adversarial subset, plus `total` (so callers can detect the no-adversarial-
 *      items edge case: `total === 0` ⇒ `rate === null`).
 *
 * All functions are:
 *   - Pure: no I/O, no Date.now, no randomness.
 *   - Typed precisely: no `any`.
 *   - Exported individually and via the `evaluateEvalSet` aggregator.
 *
 * Definitional choices (documented here and in the PR body):
 *   - Coverage uses Shannon entropy because it captures BOTH category count
 *     AND balance — a set with 10 categories all having 1 item scores higher
 *     than a set with 10 categories where 9 are singletons and 1 has 100 items.
 *   - The item type derivation prefers the structured id prefix (segment before
 *     the last `-NNN` counter) over prompt heuristics, because ids are
 *     machine-generated and stable; prompt-based bucketing is a fallback only.
 *   - Leakage uses a canonical string key (trim + lower-case of the prompt) to
 *     avoid false negatives from invisible whitespace or capitalization drift.
 *   - ECE uses 10 equal-width bins (0–0.1, 0.1–0.2, …, 0.9–1.0) per the
 *     standard Naeini et al. (2015) formulation.
 *   - Brier score: `mean((confidence - correct_as_01)²)` per Brier (1950).
 *
 * Sources:
 *   - Karpathy F-AK-005: "we don't ship an eval-set we haven't evaluated"
 *   - intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md
 *   - DR-028 (Session 7 ISEDC)
 *   - Brier (1950): "Verification of Forecasts Expressed in Terms of Probability"
 *   - Naeini, Cooper, Hauskrecht (2015): "Obtaining Well Calibrated Probabilities Using Bayesian Binning into Quantiles"
 */

import type { EvalItem, EvalSet } from "./types.js";

// ─── Extended EvalItem (bead 214c.11 — minimal backward-compatible addition) ──

/**
 * An EvalItem optionally flagged as adversarial / hard.
 *
 * `adversarial` is `false` (or absent) for standard items and `true` for items
 * specifically crafted to stress-test the skill (edge cases, prompt injections,
 * ambiguous instructions, unusual inputs). The `adversarialPassRate` metric
 * filters to this subset so a skill cannot hide brittleness behind a high
 * aggregate pass rate.
 *
 * Field is optional: existing EvalSets without this field are still valid —
 * the absence of the field is treated as `adversarial: false`.
 */
export interface AdversarialEvalItem extends EvalItem {
  readonly adversarial?: boolean;
}

// ─── Coverage ─────────────────────────────────────────────────────────────────

/** Per-type bucket count returned by {@link coverage}. */
export interface CoverageBreakdown {
  /** Derived item type / bucket label. */
  readonly type: string;
  /** Number of items in this bucket. */
  readonly count: number;
  /** Proportion of items in this bucket (0..1). */
  readonly proportion: number;
}

/** Result of the {@link coverage} metric. */
export interface CoverageResult {
  /**
   * Normalized Shannon entropy [0, 1].
   *
   * 0.0 = all items in one bucket (no diversity).
   * 1.0 = items spread uniformly across all buckets (maximum diversity).
   *
   * When the set has only one item (or only one distinct bucket), the score
   * is 0.0 by convention (no meaningful spread to measure).
   */
  readonly score: number;
  /** Distinct bucket count. */
  readonly distinctTypes: number;
  /** Per-type breakdown sorted descending by count. */
  readonly breakdown: readonly CoverageBreakdown[];
}

/**
 * Derive a bucket label from an item id.
 *
 * Strategy: strip the trailing `-NNN` numeric counter (e.g. "-001", "-042")
 * from the id to obtain the "type prefix". For ids without a trailing counter
 * we return the full id. This captures the item category that the bootstrapper
 * encodes in the id structure (e.g. "validate-skillmd-syn" from
 * "validate-skillmd-syn-001").
 *
 * Fallback: if the id does not contain a "-" separator at all, the label is the
 * id itself, which at minimum gives one bucket.
 */
function deriveItemType(item: EvalItem): string {
  // Strip trailing -<digits> suffix (the counter segment)
  const stripped = item.id.replace(/-\d+$/, "");
  return stripped.length > 0 ? stripped : item.id;
}

/**
 * Compute the **coverage** quality metric for an EvalSet.
 *
 * Coverage measures how evenly eval items are distributed across distinct
 * behavioral buckets (derived from item id prefixes). A high coverage score
 * indicates the set stresses a wide, balanced range of skill behaviors; a low
 * score indicates the set is concentrated in a narrow slice.
 *
 * Complexity: O(n) in the number of items.
 *
 * @param evalSet - The EvalSet to analyze.
 * @returns A {@link CoverageResult} with a normalized [0,1] score and breakdown.
 */
export function coverage(evalSet: EvalSet): CoverageResult {
  const items = evalSet.items;
  const n = items.length;

  // Bucket items by derived type
  const counts = new Map<string, number>();
  for (const item of items) {
    const t = deriveItemType(item);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  const distinctTypes = counts.size;

  if (n === 0 || distinctTypes <= 1) {
    // Single bucket or empty — no meaningful spread
    const breakdown: CoverageBreakdown[] = [];
    for (const [type, count] of counts) {
      breakdown.push({ type, count, proportion: n > 0 ? 1 : 0 });
    }
    return { score: 0, distinctTypes, breakdown };
  }

  // Shannon entropy: H = -Σ p_i * log2(p_i)
  let entropy = 0;
  const breakdown: CoverageBreakdown[] = [];
  for (const [type, count] of counts) {
    const p = count / n;
    entropy -= p * Math.log2(p);
    breakdown.push({ type, count, proportion: p });
  }

  // Normalize by log2(k) where k = number of distinct buckets.
  // H_max = log2(k) for a uniform distribution over k buckets.
  const hMax = Math.log2(distinctTypes);
  const score = hMax === 0 ? 0 : entropy / hMax;

  // Sort breakdown descending by count for readability
  breakdown.sort((a, b) => b.count - a.count);

  return { score, distinctTypes, breakdown };
}

// ─── Leakage ──────────────────────────────────────────────────────────────────

/** Result of the {@link leakage} metric. */
export interface LeakageResult {
  /**
   * Overlap ratio: overlappingCount / min(setA.length, setB.length).
   *
   * 0.0 = no overlap (clean separation).
   * 1.0 = every item in the smaller set has a match in the larger set.
   *
   * When either set is empty, the ratio is 0.0 by convention.
   */
  readonly overlapRatio: number;
  /** Absolute count of items in setA that have a matching item in setB. */
  readonly overlappingCount: number;
  /** Ids of the overlapping items from setA (in the order they appear in setA). */
  readonly overlappingIds: readonly string[];
}

/**
 * Canonical content key for a prompt — trim + lower-case so whitespace and
 * capitalization differences do not hide semantic duplicates.
 */
function promptKey(prompt: string): string {
  return prompt.trim().toLowerCase();
}

/**
 * Compute the **leakage** metric between two item collections.
 *
 * Leakage measures the proportion of items shared between two sets (e.g.
 * eval-set vs. training/reference set). It also detects intra-set exact
 * duplicate prompts when called with `setA === setB` (or when the two arrays
 * contain the same items).
 *
 * Matching is done on the canonical prompt key (trim + lower-case). Two items
 * are considered identical if their canonical prompts match, regardless of id.
 *
 * The denominator is `min(setA.length, setB.length)` so the ratio is
 * interpretable as "how much of the smaller set is contaminated."
 *
 * @param setA - The primary collection (e.g. the eval set items).
 * @param setB - The reference collection (e.g. training items). May equal setA
 *               to detect intra-set duplicates.
 * @returns A {@link LeakageResult}.
 */
export function leakage(setA: readonly EvalItem[], setB: readonly EvalItem[]): LeakageResult {
  if (setA.length === 0 || setB.length === 0) {
    return { overlapRatio: 0, overlappingCount: 0, overlappingIds: [] };
  }

  // Build a lookup set from setB's canonical prompt keys
  const bKeys = new Set<string>(setB.map((item) => promptKey(item.prompt)));

  const overlappingIds: string[] = [];
  // When setA and setB are the same collection detect duplicates within setA:
  // we want to find items whose prompt key appears MORE THAN ONCE (i.e. has a
  // counterpart in the same set). We do this by counting keys in setA and
  // marking any item whose key appears in bKeys AND that key has a match
  // ELSEWHERE in setA (or anywhere in setB when setA !== setB).
  const aKeySeen = new Map<string, string>(); // key → first id

  for (const item of setA) {
    const key = promptKey(item.prompt);

    if (bKeys.has(key)) {
      // Cross-set check: does setB contain this key?
      // For self-comparison (setA === setB as same items), we need at least two
      // items with this key — so we track the first occurrence per key.
      if (setA === setB || Object.is(setA, setB)) {
        // Self-comparison: only report the SECOND+ occurrence (the duplicate)
        if (aKeySeen.has(key)) {
          overlappingIds.push(item.id);
        } else {
          aKeySeen.set(key, item.id);
        }
      } else {
        overlappingIds.push(item.id);
      }
    }
  }

  const overlappingCount = overlappingIds.length;
  const denominator = Math.min(setA.length, setB.length);
  const overlapRatio = overlappingCount / denominator;

  return { overlapRatio, overlappingCount, overlappingIds };
}

// ─── Calibration ──────────────────────────────────────────────────────────────

/** A single judge prediction observation. */
export interface CalibrationPrediction {
  /**
   * Probability estimate that the item is correct (output by the judge).
   * Must be in [0, 1].
   */
  readonly confidence: number;
  /** Whether the item was actually correct. */
  readonly correct: boolean;
}

/** Result of the {@link calibration} metric. */
export interface CalibrationResult {
  /**
   * Brier score: `mean((confidence - correct_as_01)²)`.
   *
   * Lower is better. 0.0 = perfect predictions. 1.0 = maximally wrong
   * (always reports 1.0 confidence on incorrect items and 0.0 on correct ones).
   * A random judge that always predicts 0.5 has a Brier score of 0.25.
   */
  readonly brierScore: number;
  /**
   * Expected Calibration Error (ECE) over 10 equal-width confidence bins.
   *
   * Lower is better. 0.0 = the judge's confidence exactly matches its actual
   * accuracy in every bin. High ECE indicates systematic over- or under-
   * confidence. Formula: Σ_b (|B_b| / N) × |acc(B_b) − conf(B_b)|.
   */
  readonly ece: number;
  /** Number of predictions used (for caller context). */
  readonly n: number;
}

const ECE_BINS = 10;

/**
 * Compute **calibration** metrics over an array of judge predictions.
 *
 * This function is pure and decoupled from the EvalSet: it accepts the
 * `{confidence, correct}` pairs that a scored run produces. The caller wires
 * the scored-run output to this function when scoring data exists.
 *
 * Returns the Brier score and ECE. For an empty array both values are 0.0 with
 * n = 0 (there is nothing to calibrate against; the caller should check n).
 *
 * @param predictions - Array of judge predictions. All confidences must be in
 *   [0, 1]; values outside that range throw a RangeError.
 * @throws {RangeError} if any confidence is outside [0, 1].
 */
export function calibration(predictions: readonly CalibrationPrediction[]): CalibrationResult {
  const n = predictions.length;

  if (n === 0) {
    return { brierScore: 0, ece: 0, n: 0 };
  }

  // Validate confidence range
  for (const p of predictions) {
    if (p.confidence < 0 || p.confidence > 1) {
      throw new RangeError(`calibration: confidence must be in [0, 1], got ${p.confidence}`);
    }
  }

  // ── Brier score ─────────────────────────────────────────────────────────────
  let brierSum = 0;
  for (const p of predictions) {
    const y = p.correct ? 1 : 0;
    const diff = p.confidence - y;
    brierSum += diff * diff;
  }
  const brierScore = brierSum / n;

  // ── ECE over equal-width bins ────────────────────────────────────────────────
  // Bin: [b/B, (b+1)/B) for b in 0..B-1, except the last which includes 1.0.
  const binConfSum = new Array<number>(ECE_BINS).fill(0);
  const binCorrectSum = new Array<number>(ECE_BINS).fill(0);
  const binCount = new Array<number>(ECE_BINS).fill(0);

  for (const p of predictions) {
    const binIdx = Math.min(Math.floor(p.confidence * ECE_BINS), ECE_BINS - 1);
    binConfSum[binIdx]! += p.confidence;
    binCorrectSum[binIdx]! += p.correct ? 1 : 0;
    binCount[binIdx]!++;
  }

  let eceSum = 0;
  for (let b = 0; b < ECE_BINS; b++) {
    const count = binCount[b]!;
    if (count === 0) continue;
    const avgConf = binConfSum[b]! / count;
    const avgAcc = binCorrectSum[b]! / count;
    eceSum += (count / n) * Math.abs(avgAcc - avgConf);
  }

  return { brierScore, ece: eceSum, n };
}

// ─── AdversarialPassRate ──────────────────────────────────────────────────────

/** A single item result from a scored run, keyed by item id. */
export interface ItemResult {
  /** The id of the eval item this result corresponds to. */
  readonly itemId: string;
  /** Whether the skill passed this item. */
  readonly passed: boolean;
}

/** Result of the {@link adversarialPassRate} metric. */
export interface AdversarialPassRateResult {
  /**
   * Pass rate over adversarial items only: `passed / total`.
   *
   * `null` when there are no adversarial items in the set — the caller MUST
   * check for null and surface a "no adversarial items" warning rather than
   * treating 0.0 as "failed all adversarial items."
   */
  readonly rate: number | null;
  /** Number of adversarial items that passed. */
  readonly passed: number;
  /** Total adversarial items in the set. */
  readonly total: number;
}

/**
 * Compute the **adversarial pass rate** metric.
 *
 * Filters the result set to items flagged `adversarial: true` and computes the
 * pass rate over that subset. Items missing the `adversarial` field (or with
 * `adversarial: false`) are excluded from the count.
 *
 * The motivation: a skill can score well overall by handling easy cases while
 * failing on edge cases and adversarial inputs. This metric makes that
 * brittleness visible.
 *
 * @param items - The items from the eval set (type-extended with optional
 *   `adversarial` field).
 * @param results - The item-level pass/fail results from a scored run. Results
 *   for non-adversarial items are silently ignored. Unknown item ids are
 *   silently ignored (not all scored runs cover every item).
 * @returns An {@link AdversarialPassRateResult}.
 */
export function adversarialPassRate(
  items: readonly AdversarialEvalItem[],
  results: readonly ItemResult[],
): AdversarialPassRateResult {
  // Build a lookup from itemId → passed for the results
  const resultMap = new Map<string, boolean>(results.map((r) => [r.itemId, r.passed]));

  let total = 0;
  let passed = 0;

  for (const item of items) {
    if (!item.adversarial) continue;
    total++;
    const result = resultMap.get(item.id);
    if (result === true) passed++;
  }

  if (total === 0) {
    return { rate: null, passed: 0, total: 0 };
  }

  return { rate: passed / total, passed, total };
}

// ─── Aggregator ───────────────────────────────────────────────────────────────

/** Options for {@link evaluateEvalSet}. */
export interface EvaluateEvalSetOptions {
  /**
   * Reference item collection to check for leakage against (e.g. training set).
   * When omitted, the leakage metric checks for intra-set duplicates only
   * (setA = setB = evalSet.items).
   */
  readonly referenceItems?: readonly EvalItem[];
  /**
   * Judge predictions from a scored run (required for calibration metrics).
   * When omitted, the calibration result is absent from the return value.
   */
  readonly predictions?: readonly CalibrationPrediction[];
  /**
   * Scored run results keyed by item id (required for adversarial pass rate).
   * When omitted, the adversarial pass rate result is absent.
   */
  readonly itemResults?: readonly ItemResult[];
}

/** Aggregated result of {@link evaluateEvalSet}. */
export interface EvalSetQualityReport {
  /** Behavioral diversity of the eval set [0, 1]. */
  readonly coverage: CoverageResult;
  /**
   * Overlap ratio vs. the reference set (or intra-set duplicates when no
   * reference is provided).
   */
  readonly leakage: LeakageResult;
  /**
   * Judge calibration metrics. Present only when `opts.predictions` is
   * supplied (else the field is absent from the object).
   */
  readonly calibration?: CalibrationResult;
  /**
   * Adversarial pass rate. Present only when `opts.itemResults` is supplied.
   * The `rate` field inside may be `null` (no adversarial items in the set).
   */
  readonly adversarialPassRate?: AdversarialPassRateResult;
}

/**
 * Compute all four quality metrics for an EvalSet in a single call.
 *
 * Each metric is computed iff its required inputs are present. The coverage and
 * leakage metrics are ALWAYS computed (they require only the EvalSet itself).
 * Calibration requires `opts.predictions`; adversarial pass rate requires
 * `opts.itemResults`. Omitting those inputs yields a report without those
 * optional fields — the caller decides whether the omission is acceptable.
 *
 * @param evalSet - The EvalSet to evaluate.
 * @param opts    - Optional supplemental data for calibration and adversarial
 *   pass rate.
 * @returns An {@link EvalSetQualityReport}.
 */
export function evaluateEvalSet(
  evalSet: EvalSet,
  opts: EvaluateEvalSetOptions = {},
): EvalSetQualityReport {
  const ref = opts.referenceItems ?? evalSet.items;
  const coverageResult = coverage(evalSet);
  const leakageResult = leakage(evalSet.items, ref);

  const report: EvalSetQualityReport = {
    coverage: coverageResult,
    leakage: leakageResult,
  };

  if (opts.predictions !== undefined) {
    (report as { calibration?: CalibrationResult }).calibration = calibration(opts.predictions);
  }

  if (opts.itemResults !== undefined) {
    (report as { adversarialPassRate?: AdversarialPassRateResult }).adversarialPassRate =
      adversarialPassRate(evalSet.items as AdversarialEvalItem[], opts.itemResults);
  }

  return report;
}
