import { describe, it, expect } from "vitest";
import {
  accept,
  isSignificantImprovement,
  isSignificantRegression,
  SATURATION_CEILING,
} from "./accept.js";
import type { ScoreRecord, ScoreDimension } from "./types.js";
import { DEFAULT_ALPHA } from "./types.js";

const EVAL = "e".repeat(64);
const SKILL_V1 = "1".repeat(64);
const SKILL_V2 = "2".repeat(64);

/** Deterministic dimension (variance 0): exact comparison. */
function det(value: number): ScoreDimension {
  return { value, variance: 0, n: 1 };
}

/** Noisy dimension with explicit variance + sample count. */
function dim(value: number, variance: number, n: number): ScoreDimension {
  return { value, variance, n };
}

function record(skill: string, dims: Record<string, ScoreDimension>, evalSet = EVAL): ScoreRecord {
  return {
    skill,
    evalSet,
    behavioral: dims.behavioral,
    dimensions: dims,
  };
}

describe("accept — DR-028 P0-RATIFY-1 predicate", () => {
  it("ACCEPTS: strict behavioral gain, all other dims non-regressing (deterministic)", () => {
    const v1 = record(SKILL_V1, { behavioral: det(0.7), readability: det(0.9) });
    const v2 = record(SKILL_V2, { behavioral: det(0.8), readability: det(0.9) });
    expect(accept(v1, v2)).toEqual({ accepted: true });
  });

  it("ACCEPTS: behavioral gain AND another dim also improves", () => {
    const v1 = record(SKILL_V1, { behavioral: det(0.7), readability: det(0.8) });
    const v2 = record(SKILL_V2, { behavioral: det(0.8), readability: det(0.95) });
    expect(accept(v1, v2)).toEqual({ accepted: true });
  });

  it("REJECTS no-behavioral-improvement: behavioral unchanged, others improve", () => {
    const v1 = record(SKILL_V1, { behavioral: det(0.7), readability: det(0.8) });
    const v2 = record(SKILL_V2, { behavioral: det(0.7), readability: det(0.95) });
    expect(accept(v1, v2)).toEqual({
      accepted: false,
      reason: "no-behavioral-improvement",
    });
  });

  it("REJECTS no-behavioral-improvement: behavioral REGRESSES", () => {
    const v1 = record(SKILL_V1, { behavioral: det(0.8), readability: det(0.8) });
    const v2 = record(SKILL_V2, { behavioral: det(0.7), readability: det(0.9) });
    // behavioral did not improve; readability improved (no regression) → gate
    // failed on behavioral alone.
    expect(accept(v1, v2)).toEqual({
      accepted: false,
      reason: "no-behavioral-improvement",
    });
  });

  it("REJECTS pareto-incomparable: behavioral up BUT another dim regresses (the tie-break)", () => {
    const v1 = record(SKILL_V1, { behavioral: det(0.7), readability: det(0.9) });
    const v2 = record(SKILL_V2, { behavioral: det(0.85), readability: det(0.6) });
    expect(accept(v1, v2)).toEqual({
      accepted: false,
      reason: "pareto-incomparable",
    });
  });

  it("REJECTS regressed-named-dimension: behavioral flat AND another dim regresses", () => {
    const v1 = record(SKILL_V1, { behavioral: det(0.7), readability: det(0.9) });
    const v2 = record(SKILL_V2, { behavioral: det(0.7), readability: det(0.6) });
    expect(accept(v1, v2)).toEqual({
      accepted: false,
      reason: "regressed-named-dimension",
    });
  });

  it("REJECTS incomparable-records: different eval sets", () => {
    const v1 = record(SKILL_V1, { behavioral: det(0.7) }, EVAL);
    const v2 = record(SKILL_V2, { behavioral: det(0.9) }, "f".repeat(64));
    expect(accept(v1, v2)).toEqual({
      accepted: false,
      reason: "incomparable-records",
    });
  });

  it("REJECTS regressed-named-dimension: candidate DROPPED a dimension the baseline measured", () => {
    const v1 = record(SKILL_V1, { behavioral: det(0.7), readability: det(0.9) });
    // candidate only carries behavioral — readability guarantee dropped.
    const v2 = record(SKILL_V2, { behavioral: det(0.8) });
    expect(accept(v1, v2)).toEqual({
      accepted: false,
      reason: "pareto-incomparable",
    });
  });

  it("TIE: identical scores → no behavioral improvement (reject)", () => {
    const v1 = record(SKILL_V1, { behavioral: det(0.7), readability: det(0.8) });
    const v2 = record(SKILL_V2, { behavioral: det(0.7), readability: det(0.8) });
    expect(accept(v1, v2)).toEqual({
      accepted: false,
      reason: "no-behavioral-improvement",
    });
  });

  describe("statistical significance at α=0.05", () => {
    it("REJECTS a behavioral gain too small to be significant given the noise", () => {
      // +0.01 with large variance / few samples → not significant.
      const v1 = record(SKILL_V1, { behavioral: dim(0.7, 0.25, 10) });
      const v2 = record(SKILL_V2, { behavioral: dim(0.71, 0.25, 10) });
      expect(accept(v1, v2)).toEqual({
        accepted: false,
        reason: "no-behavioral-improvement",
      });
    });

    it("ACCEPTS a behavioral gain large enough to be significant", () => {
      // +0.30 with modest variance + many samples → clearly significant.
      const v1 = record(SKILL_V1, { behavioral: dim(0.5, 0.04, 100) });
      const v2 = record(SKILL_V2, { behavioral: dim(0.8, 0.04, 100) });
      expect(accept(v1, v2)).toEqual({ accepted: true });
    });

    it("does NOT count an insignificant dip on a named dim as a regression", () => {
      // behavioral significantly up; readability dips by a hair within noise.
      const v1 = record(SKILL_V1, {
        behavioral: dim(0.5, 0.04, 100),
        readability: dim(0.9, 0.25, 50),
      });
      const v2 = record(SKILL_V2, {
        behavioral: dim(0.8, 0.04, 100),
        readability: dim(0.89, 0.25, 50),
      });
      expect(accept(v1, v2)).toEqual({ accepted: true });
    });

    it("DOES count a significant drop on a named dim as a regression (incomparable)", () => {
      const v1 = record(SKILL_V1, {
        behavioral: dim(0.5, 0.04, 100),
        readability: dim(0.9, 0.01, 100),
      });
      const v2 = record(SKILL_V2, {
        behavioral: dim(0.8, 0.04, 100),
        readability: dim(0.6, 0.01, 100),
      });
      expect(accept(v1, v2)).toEqual({
        accepted: false,
        reason: "pareto-incomparable",
      });
    });
  });

  it("respects a custom alpha (stricter alpha can flip an acceptance to a rejection)", () => {
    // SE = sqrt(0.04/30 + 0.04/30) ≈ 0.0516. delta = 0.10 → z ≈ 1.94:
    //   significant at α=0.05 (z* 1.645) but NOT at α=0.001 (z* ≈ 3.09).
    const v1 = record(SKILL_V1, { behavioral: dim(0.5, 0.04, 30) });
    const v2 = record(SKILL_V2, { behavioral: dim(0.6, 0.04, 30) });
    const lenient = accept(v1, v2, DEFAULT_ALPHA);
    const strict = accept(v1, v2, 0.001);
    expect(lenient.accepted).toBe(true);
    expect(strict.accepted).toBe(false);
  });
});

describe("isSignificantImprovement / isSignificantRegression", () => {
  it("deterministic dims reduce to exact comparison", () => {
    expect(isSignificantImprovement(det(0.8), det(0.7))).toBe(true);
    expect(isSignificantImprovement(det(0.7), det(0.7))).toBe(false);
    expect(isSignificantRegression(det(0.6), det(0.7))).toBe(true);
    expect(isSignificantRegression(det(0.7), det(0.7))).toBe(false);
  });

  it("a non-positive delta is never an improvement; a non-negative delta is never a regression", () => {
    expect(isSignificantImprovement(dim(0.7, 0.1, 10), dim(0.7, 0.1, 10))).toBe(false);
    expect(isSignificantRegression(dim(0.7, 0.1, 10), dim(0.7, 0.1, 10))).toBe(false);
  });
});

describe("accept — saturated-baseline (000-docs/043, htjt.27)", () => {
  it("names a saturated baseline instead of a generic no-improvement", () => {
    const base = record(SKILL_V1, { behavioral: det(1) });
    const cand = record(SKILL_V2, { behavioral: det(1) });
    expect(accept(base, cand)).toEqual({ accepted: false, reason: "saturated-baseline" });
  });

  it("applies at the 0.95 ceiling when the gain is not significant", () => {
    const base = record(SKILL_V1, { behavioral: dim(0.96, 0.04, 10) });
    const cand = record(SKILL_V2, { behavioral: dim(0.97, 0.03, 10) });
    expect(accept(base, cand)).toEqual({ accepted: false, reason: "saturated-baseline" });
    expect(SATURATION_CEILING).toBe(0.95);
  });

  it("keeps no-behavioral-improvement below the ceiling", () => {
    const base = record(SKILL_V1, { behavioral: det(0.5) });
    const cand = record(SKILL_V2, { behavioral: det(0.5) });
    expect(accept(base, cand)).toEqual({ accepted: false, reason: "no-behavioral-improvement" });
  });

  it("lets a named regression win over saturation", () => {
    const base = record(SKILL_V1, { behavioral: det(1), latency: det(0.9) });
    const cand = record(SKILL_V2, { behavioral: det(1), latency: det(0.5) });
    expect(accept(base, cand)).toEqual({ accepted: false, reason: "regressed-named-dimension" });
  });

  it("never treats a non-proportion behavioral scale as saturated", () => {
    const base = record(SKILL_V1, { behavioral: det(5) });
    const cand = record(SKILL_V2, { behavioral: det(5) });
    expect(accept(base, cand)).toEqual({ accepted: false, reason: "no-behavioral-improvement" });
  });
});
