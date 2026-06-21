/**
 * eval-set-metrics.test.ts — quality metrics for an EvalSet (bead 214c.11).
 *
 * Each metric is tested with synthetic inputs that exercise:
 *   - Expected numerical values (not just shapes).
 *   - Edge cases and boundary conditions.
 *   - The contrast between "healthy" and "pathological" inputs.
 *
 * No mocking of the units under test.
 */

import { describe, it, expect } from "vitest";
import {
  coverage,
  leakage,
  calibration,
  adversarialPassRate,
  evaluateEvalSet,
} from "./eval-set-metrics.js";
import type { AdversarialEvalItem, CalibrationPrediction, ItemResult } from "./eval-set-metrics.js";
import type { EvalItem, EvalSet } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_HASH = "a".repeat(64);
const VALID_LINEAGE_ID = "0192cae6-0001-7000-8000-000000000000";

function makeItem(id: string, prompt: string, adversarial?: boolean): AdversarialEvalItem {
  return { id, prompt, adversarial };
}

function makeEvalSet(items: readonly EvalItem[]): EvalSet {
  return {
    hash: VALID_HASH,
    skillId: "test-skill",
    source: "synthetic",
    items,
    evalSetVersion: "1.0.0",
    lineageParent: null,
    refreshDueAt: "2027-01-01T00:00:00.000Z",
    lineageId: VALID_LINEAGE_ID,
  };
}

// ─── coverage ─────────────────────────────────────────────────────────────────

describe("coverage", () => {
  it("returns 1.0 for a perfectly uniform distribution across multiple buckets", () => {
    // 3 items, 3 distinct buckets (each prefix maps to one item)
    // Entropy = -3 * (1/3 * log2(1/3)) = log2(3); normalized = log2(3)/log2(3) = 1.0
    const items = [
      makeItem("bucket-a-001", "Prompt for bucket A"),
      makeItem("bucket-b-001", "Prompt for bucket B"),
      makeItem("bucket-c-001", "Prompt for bucket C"),
    ];
    const result = coverage(makeEvalSet(items));
    expect(result.score).toBeCloseTo(1.0, 10);
    expect(result.distinctTypes).toBe(3);
  });

  it("returns 0.0 when all items are in the same bucket", () => {
    // All items share the prefix "validate-skillmd-syn" — one bucket
    const items = [
      makeItem("validate-skillmd-syn-001", "Prompt 1"),
      makeItem("validate-skillmd-syn-002", "Prompt 2"),
      makeItem("validate-skillmd-syn-003", "Prompt 3"),
    ];
    const result = coverage(makeEvalSet(items));
    expect(result.score).toBe(0);
    expect(result.distinctTypes).toBe(1);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0]!.count).toBe(3);
  });

  it("returns a score between 0 and 1 for a skewed distribution", () => {
    // 4 items in bucket A, 1 in bucket B → skewed
    const items = [
      makeItem("a-001", "Alpha one"),
      makeItem("a-002", "Alpha two"),
      makeItem("a-003", "Alpha three"),
      makeItem("a-004", "Alpha four"),
      makeItem("b-001", "Beta one"),
    ];
    const result = coverage(makeEvalSet(items));
    // Score must be in (0, 1) — lower than uniform, higher than degenerate
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
    expect(result.distinctTypes).toBe(2);
  });

  it("computes known entropy for a 2-bucket 50/50 split", () => {
    // 2 items, 2 buckets, each 50% → H = 1 bit, H_max = log2(2) = 1 → score = 1.0
    const items = [makeItem("bucket-x-001", "Prompt X"), makeItem("bucket-y-001", "Prompt Y")];
    const result = coverage(makeEvalSet(items));
    expect(result.score).toBeCloseTo(1.0, 10);
  });

  it("computes known entropy for a 4-bucket uniform split", () => {
    // 4 items, 4 buckets → H = log2(4) = 2, H_max = 2, score = 1.0
    const items = [
      makeItem("w-001", "W prompt"),
      makeItem("x-001", "X prompt"),
      makeItem("y-001", "Y prompt"),
      makeItem("z-001", "Z prompt"),
    ];
    const result = coverage(makeEvalSet(items));
    expect(result.score).toBeCloseTo(1.0, 10);
    expect(result.distinctTypes).toBe(4);
  });

  it("computes known entropy for a skewed 3:1 split across 2 buckets", () => {
    // 3 in bucket A, 1 in bucket B
    // H = -(3/4)*log2(3/4) - (1/4)*log2(1/4)
    //   = -(3/4)*(-0.41504) - (1/4)*(-2) = 0.31128 + 0.5 = 0.81128
    // H_max = log2(2) = 1 → score ≈ 0.81128
    const items = [
      makeItem("a-001", "A prompt one"),
      makeItem("a-002", "A prompt two"),
      makeItem("a-003", "A prompt three"),
      makeItem("b-001", "B prompt one"),
    ];
    const result = coverage(makeEvalSet(items));
    const expected = -(3 / 4) * Math.log2(3 / 4) - (1 / 4) * Math.log2(1 / 4);
    expect(result.score).toBeCloseTo(expected, 8);
  });

  it("returns 0 for a single-item set (one bucket)", () => {
    const items = [makeItem("only-001", "The only prompt")];
    const result = coverage(makeEvalSet(items));
    expect(result.score).toBe(0);
    expect(result.distinctTypes).toBe(1);
  });

  it("breakdown proportions sum to 1", () => {
    const items = [
      makeItem("p-001", "Prompt P1"),
      makeItem("p-002", "Prompt P2"),
      makeItem("q-001", "Prompt Q1"),
    ];
    const result = coverage(makeEvalSet(items));
    const totalProportion = result.breakdown.reduce((sum, b) => sum + b.proportion, 0);
    expect(totalProportion).toBeCloseTo(1.0, 10);
  });

  it("breakdown is sorted descending by count", () => {
    const items = [
      makeItem("rare-001", "Rare prompt"),
      makeItem("common-001", "Common A"),
      makeItem("common-002", "Common B"),
      makeItem("common-003", "Common C"),
    ];
    const result = coverage(makeEvalSet(items));
    for (let i = 0; i < result.breakdown.length - 1; i++) {
      expect(result.breakdown[i]!.count).toBeGreaterThanOrEqual(result.breakdown[i + 1]!.count);
    }
  });
});

// ─── leakage ─────────────────────────────────────────────────────────────────

describe("leakage", () => {
  const itemA = makeItem("a-001", "What does this skill do?");
  const itemB = makeItem("b-001", "Validate the input schema.");
  const itemC = makeItem("c-001", "Apply the transformation.");
  const itemD = makeItem("d-001", "What does this skill do?"); // same prompt as itemA

  it("returns 0 ratio for disjoint sets", () => {
    const result = leakage([itemA, itemB], [itemC]);
    expect(result.overlapRatio).toBe(0);
    expect(result.overlappingCount).toBe(0);
    expect(result.overlappingIds).toHaveLength(0);
  });

  it("returns 1.0 ratio when sets are identical (all prompts overlap)", () => {
    const result = leakage([itemA, itemB], [itemA, itemB]);
    // Self-comparison: detects duplicates. With identical content but DIFFERENT array
    // references, each item in setA has a match in setB. Because setA !== setB
    // (different array references), we use cross-set logic.
    // overlapRatio = overlappingCount / min(2, 2) = 2/2 = 1.0
    expect(result.overlapRatio).toBeCloseTo(1.0, 10);
    expect(result.overlappingCount).toBe(2);
    expect(result.overlappingIds).toContain("a-001");
    expect(result.overlappingIds).toContain("b-001");
  });

  it("returns partial ratio when one item overlaps", () => {
    // setA has 2 items, setB has 2 items, 1 overlaps
    const result = leakage([itemA, itemB], [itemD, itemC]); // itemD has same prompt as itemA
    // overlapRatio = 1 / min(2, 2) = 0.5
    expect(result.overlapRatio).toBeCloseTo(0.5, 10);
    expect(result.overlappingCount).toBe(1);
    expect(result.overlappingIds).toContain("a-001");
  });

  it("detects intra-set duplicates when setA is compared to itself (same reference)", () => {
    // Items with duplicate prompts within the same set
    const dupeSet = [itemA, itemB, itemD]; // itemA and itemD share the same prompt
    const result = leakage(dupeSet, dupeSet);
    // itemD is the duplicate of itemA (second occurrence of the same prompt)
    expect(result.overlappingCount).toBeGreaterThan(0);
    expect(result.overlappingIds).toContain("d-001");
  });

  it("returns 0 for an empty setA", () => {
    const result = leakage([], [itemA, itemB]);
    expect(result.overlapRatio).toBe(0);
    expect(result.overlappingCount).toBe(0);
  });

  it("returns 0 for an empty setB", () => {
    const result = leakage([itemA, itemB], []);
    expect(result.overlapRatio).toBe(0);
    expect(result.overlappingCount).toBe(0);
  });

  it("is case-insensitive in prompt matching", () => {
    const upper = makeItem("u-001", "WHAT DOES THIS SKILL DO?");
    const lower = makeItem("l-001", "what does this skill do?");
    const result = leakage([upper], [lower]);
    expect(result.overlapRatio).toBeCloseTo(1.0, 10);
  });

  it("ignores leading/trailing whitespace in prompt matching", () => {
    const padded = makeItem("p-001", "  Validate the input schema.  ");
    const clean = makeItem("c-001", "Validate the input schema.");
    const result = leakage([padded], [clean]);
    expect(result.overlapRatio).toBeCloseTo(1.0, 10);
  });

  it("uses min(setA, setB) as denominator (smaller set is the reference)", () => {
    // setA has 4 items, setB has 2 items; all setB items match setA
    const setA = [itemA, itemB, itemC, makeItem("x-001", "Extra prompt.")];
    const setB = [itemA, itemB];
    const result = leakage(setA, setB);
    // denominator = min(4, 2) = 2; overlapping = 2 → ratio = 1.0
    expect(result.overlapRatio).toBeCloseTo(1.0, 10);
  });
});

// ─── calibration ─────────────────────────────────────────────────────────────

describe("calibration", () => {
  it("returns 0 brier score and 0 ECE for an empty array", () => {
    const result = calibration([]);
    expect(result.brierScore).toBe(0);
    expect(result.ece).toBe(0);
    expect(result.n).toBe(0);
  });

  it("returns brier score 0 for a perfectly correct judge (all confident correct)", () => {
    // Judge always predicts confidence=1.0 and is always correct
    const predictions: CalibrationPrediction[] = [
      { confidence: 1, correct: true },
      { confidence: 1, correct: true },
      { confidence: 1, correct: true },
    ];
    const result = calibration(predictions);
    expect(result.brierScore).toBeCloseTo(0, 10);
    expect(result.n).toBe(3);
  });

  it("returns brier score 1 for a maximally wrong judge", () => {
    // Judge predicts confidence=1.0 but is always incorrect
    const predictions: CalibrationPrediction[] = [
      { confidence: 1, correct: false },
      { confidence: 1, correct: false },
    ];
    const result = calibration(predictions);
    // Brier = mean((1 - 0)^2) = 1.0
    expect(result.brierScore).toBeCloseTo(1.0, 10);
  });

  it("returns brier score 0.25 for a judge that always predicts 0.5", () => {
    // confidence=0.5 on correct: (0.5-1)^2 = 0.25
    // confidence=0.5 on incorrect: (0.5-0)^2 = 0.25
    // mean = 0.25 regardless of actual outcomes
    const predictions: CalibrationPrediction[] = [
      { confidence: 0.5, correct: true },
      { confidence: 0.5, correct: false },
      { confidence: 0.5, correct: true },
      { confidence: 0.5, correct: false },
    ];
    const result = calibration(predictions);
    expect(result.brierScore).toBeCloseTo(0.25, 10);
  });

  it("returns low ECE for a well-calibrated judge", () => {
    // 10 items: confidence 0.9 and all correct → single bin [0.9,1.0)
    // avg_conf = 0.9, avg_acc = 1.0, |1.0 - 0.9| = 0.1 → ECE = 0.1
    const predictions: CalibrationPrediction[] = Array.from({ length: 10 }, () => ({
      confidence: 0.9,
      correct: true as boolean,
    }));
    const result = calibration(predictions);
    expect(result.ece).toBeCloseTo(0.1, 6);
  });

  it("returns high ECE for a systematically over-confident judge", () => {
    // Judge always says 0.95 confidence but is only right 50% of the time
    // All predictions land in bin 9 ([0.9, 1.0)): avg_conf=0.95, avg_acc=0.5
    // ECE = (10/10) * |0.5 - 0.95| = 0.45
    const predictions: CalibrationPrediction[] = [
      { confidence: 0.95, correct: true },
      { confidence: 0.95, correct: false },
      { confidence: 0.95, correct: true },
      { confidence: 0.95, correct: false },
      { confidence: 0.95, correct: true },
      { confidence: 0.95, correct: false },
      { confidence: 0.95, correct: true },
      { confidence: 0.95, correct: false },
      { confidence: 0.95, correct: true },
      { confidence: 0.95, correct: false },
    ];
    const result = calibration(predictions);
    expect(result.ece).toBeCloseTo(0.45, 6);
  });

  it("returns near-zero ECE for perfect per-bin calibration", () => {
    // Bin [0.0, 0.1): confidence=0.05, accuracy=0 → |0 - 0.05| = 0.05
    // Bin [0.9, 1.0): confidence=0.95, accuracy=1 → |1 - 0.95| = 0.05
    // Each bin has 1 item: ECE = (1/2)*0.05 + (1/2)*0.05 = 0.05
    // (Close to 0 but not exactly because our bins have width 0.1)
    const predictions: CalibrationPrediction[] = [
      { confidence: 0.05, correct: false },
      { confidence: 0.95, correct: true },
    ];
    const result = calibration(predictions);
    expect(result.ece).toBeCloseTo(0.05, 6);
  });

  it("returns known brier score for a mixed judge", () => {
    // (0.8 - 1)^2 = 0.04, (0.3 - 0)^2 = 0.09 → mean = 0.065
    const predictions: CalibrationPrediction[] = [
      { confidence: 0.8, correct: true },
      { confidence: 0.3, correct: false },
    ];
    const result = calibration(predictions);
    expect(result.brierScore).toBeCloseTo(0.065, 10);
  });

  it("throws RangeError for confidence < 0", () => {
    const predictions: CalibrationPrediction[] = [{ confidence: -0.1, correct: true }];
    expect(() => calibration(predictions)).toThrow(RangeError);
  });

  it("throws RangeError for confidence > 1", () => {
    const predictions: CalibrationPrediction[] = [{ confidence: 1.1, correct: false }];
    expect(() => calibration(predictions)).toThrow(RangeError);
  });

  it("accepts confidence = 0 and confidence = 1 as boundary values", () => {
    const predictions: CalibrationPrediction[] = [
      { confidence: 0, correct: false },
      { confidence: 1, correct: true },
    ];
    expect(() => calibration(predictions)).not.toThrow();
  });

  it("n reflects the number of predictions passed in", () => {
    const predictions: CalibrationPrediction[] = Array.from({ length: 7 }, () => ({
      confidence: 0.5,
      correct: true as boolean,
    }));
    expect(calibration(predictions).n).toBe(7);
  });
});

// ─── adversarialPassRate ──────────────────────────────────────────────────────

describe("adversarialPassRate", () => {
  const advItem1 = makeItem("adv-001", "Adversarial prompt 1", true);
  const advItem2 = makeItem("adv-002", "Adversarial prompt 2", true);
  const normalItem = makeItem("norm-001", "Normal prompt", false);
  const untaggedItem = makeItem("untagged-001", "Untagged prompt"); // no adversarial field

  it("returns rate null when there are no adversarial items", () => {
    const results: ItemResult[] = [{ itemId: "norm-001", passed: true }];
    const result = adversarialPassRate([normalItem], results);
    expect(result.rate).toBeNull();
    expect(result.total).toBe(0);
    expect(result.passed).toBe(0);
  });

  it("returns rate null for an untagged item (adversarial absent = false)", () => {
    const results: ItemResult[] = [{ itemId: "untagged-001", passed: true }];
    const result = adversarialPassRate([untaggedItem], results);
    expect(result.rate).toBeNull();
    expect(result.total).toBe(0);
  });

  it("returns 1.0 when all adversarial items pass", () => {
    const results: ItemResult[] = [
      { itemId: "adv-001", passed: true },
      { itemId: "adv-002", passed: true },
    ];
    const result = adversarialPassRate([advItem1, advItem2], results);
    expect(result.rate).toBeCloseTo(1.0, 10);
    expect(result.passed).toBe(2);
    expect(result.total).toBe(2);
  });

  it("returns 0.0 when all adversarial items fail", () => {
    const results: ItemResult[] = [
      { itemId: "adv-001", passed: false },
      { itemId: "adv-002", passed: false },
    ];
    const result = adversarialPassRate([advItem1, advItem2], results);
    expect(result.rate).toBeCloseTo(0.0, 10);
    expect(result.passed).toBe(0);
    expect(result.total).toBe(2);
  });

  it("returns 0.5 when half the adversarial items pass", () => {
    const results: ItemResult[] = [
      { itemId: "adv-001", passed: true },
      { itemId: "adv-002", passed: false },
    ];
    const result = adversarialPassRate([advItem1, advItem2], results);
    expect(result.rate).toBeCloseTo(0.5, 10);
    expect(result.passed).toBe(1);
    expect(result.total).toBe(2);
  });

  it("ignores normal (non-adversarial) items in the count", () => {
    // Normal item is in the result set with passed=true; should not inflate rate
    const results: ItemResult[] = [
      { itemId: "adv-001", passed: false },
      { itemId: "norm-001", passed: true },
    ];
    const result = adversarialPassRate([advItem1, normalItem], results);
    expect(result.rate).toBeCloseTo(0.0, 10);
    expect(result.total).toBe(1); // only adv-001 counted
  });

  it("treats missing result for an adversarial item as a fail", () => {
    // adv-001 has no result entry → counts as not passed
    const results: ItemResult[] = [];
    const result = adversarialPassRate([advItem1], results);
    expect(result.rate).toBeCloseTo(0.0, 10);
    expect(result.passed).toBe(0);
    expect(result.total).toBe(1);
  });

  it("ignores result entries for unknown item ids", () => {
    const results: ItemResult[] = [
      { itemId: "adv-001", passed: true },
      { itemId: "unknown-999", passed: true }, // not in items
    ];
    const result = adversarialPassRate([advItem1], results);
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.rate).toBeCloseTo(1.0, 10);
  });

  it("mixed set: computes rate only over flagged adversarial items", () => {
    const items = [advItem1, advItem2, normalItem, untaggedItem];
    const results: ItemResult[] = [
      { itemId: "adv-001", passed: true },
      { itemId: "adv-002", passed: false },
      { itemId: "norm-001", passed: true },
      { itemId: "untagged-001", passed: true },
    ];
    const result = adversarialPassRate(items, results);
    // Only adv-001 and adv-002 count; 1 of 2 passed
    expect(result.rate).toBeCloseTo(0.5, 10);
    expect(result.total).toBe(2);
    expect(result.passed).toBe(1);
  });
});

// ─── evaluateEvalSet aggregator ───────────────────────────────────────────────

describe("evaluateEvalSet", () => {
  const items: AdversarialEvalItem[] = [
    makeItem("a-syn-001", "Prompt for A one"),
    makeItem("a-syn-002", "Prompt for A two"),
    makeItem("b-syn-001", "Prompt for B one", true), // adversarial
  ];

  const evalSet = makeEvalSet(items);

  it("always returns coverage and leakage", () => {
    const report = evaluateEvalSet(evalSet);
    expect(report.coverage).toBeDefined();
    expect(report.leakage).toBeDefined();
    expect(report.calibration).toBeUndefined();
    expect(report.adversarialPassRate).toBeUndefined();
  });

  it("includes calibration when predictions are provided", () => {
    const predictions: CalibrationPrediction[] = [{ confidence: 0.8, correct: true }];
    const report = evaluateEvalSet(evalSet, { predictions });
    expect(report.calibration).toBeDefined();
    expect(report.calibration!.n).toBe(1);
  });

  it("includes adversarialPassRate when itemResults are provided", () => {
    const itemResults: ItemResult[] = [{ itemId: "b-syn-001", passed: true }];
    const report = evaluateEvalSet(evalSet, { itemResults });
    expect(report.adversarialPassRate).toBeDefined();
    expect(report.adversarialPassRate!.total).toBe(1);
    expect(report.adversarialPassRate!.rate).toBeCloseTo(1.0, 10);
  });

  it("checks leakage against referenceItems when provided", () => {
    const referenceItems: EvalItem[] = [
      makeItem("ref-001", "Prompt for A one"), // exact prompt match with items[0]
    ];
    const report = evaluateEvalSet(evalSet, { referenceItems });
    // items[0] prompt matches ref-001 → at least 1 overlapping
    expect(report.leakage.overlappingCount).toBeGreaterThanOrEqual(1);
  });

  it("uses intra-set duplicate detection when no referenceItems provided", () => {
    // Items with a duplicate prompt — should be detected
    const dupItems: AdversarialEvalItem[] = [
      makeItem("x-001", "Duplicate prompt"),
      makeItem("x-002", "Duplicate prompt"), // same prompt
    ];
    const report = evaluateEvalSet(makeEvalSet(dupItems));
    // Both items are the same reference → same-ref path detects the second as duplicate
    expect(report.leakage.overlappingCount).toBeGreaterThanOrEqual(1);
  });

  it("returns all four metrics when all inputs are provided", () => {
    const predictions: CalibrationPrediction[] = [{ confidence: 0.7, correct: true }];
    const itemResults: ItemResult[] = [{ itemId: "b-syn-001", passed: false }];
    const report = evaluateEvalSet(evalSet, { predictions, itemResults });
    expect(report.coverage).toBeDefined();
    expect(report.leakage).toBeDefined();
    expect(report.calibration).toBeDefined();
    expect(report.adversarialPassRate).toBeDefined();
  });
});
