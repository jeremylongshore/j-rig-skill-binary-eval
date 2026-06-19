import { describe, it, expect } from "vitest";
import { detectRegressions } from "./regression.js";
import { compareBaseline, isObsoleteCandidate } from "./baseline.js";
import { computeScoreCard, decideRollout, buildLaunchReport } from "./scoring.js";
import { CriterionSchema } from "../schemas/criterion.js";
import type { Criterion } from "../schemas/criterion.js";
import type { JudgmentResult } from "../judgment/types.js";

function criterion(partial: {
  id: string;
  description: string;
  method: "deterministic" | "judge";
  blocker?: boolean;
  regression_critical?: boolean;
}): Criterion {
  return CriterionSchema.parse(partial);
}

function result(id: string, verdict: "yes" | "no" | "unsure"): JudgmentResult {
  return { criterion_id: id, verdict, confidence: 1, reasoning: "", method: "judge" };
}

describe("regression detection", () => {
  const criteria = [
    criterion({
      id: "c1",
      description: "Blocker",
      method: "judge",
      blocker: true,
      regression_critical: true,
    }),
    criterion({ id: "c2", description: "Normal", method: "judge" }),
  ];

  it("detects regressions", () => {
    const prev = [result("c1", "yes"), result("c2", "yes")];
    const curr = [result("c1", "yes"), result("c2", "no")];

    const regressions = detectRegressions(prev, curr, criteria);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].criterion_id).toBe("c2");
    expect(regressions[0].is_sacred).toBe(false);
  });

  it("detects sacred regressions", () => {
    const prev = [result("c1", "yes")];
    const curr = [result("c1", "no")];

    const regressions = detectRegressions(prev, curr, criteria);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].is_sacred).toBe(true);
  });

  it("does not flag improvements as regressions", () => {
    const prev = [result("c1", "no")];
    const curr = [result("c1", "yes")];

    expect(detectRegressions(prev, curr, criteria)).toHaveLength(0);
  });

  it("does not flag unchanged results", () => {
    const prev = [result("c1", "yes")];
    const curr = [result("c1", "yes")];

    expect(detectRegressions(prev, curr, criteria)).toHaveLength(0);
  });
});

describe("baseline comparison", () => {
  it("identifies when skill adds value", () => {
    const withSkill = [result("c1", "yes"), result("c2", "yes")];
    const withoutSkill = [result("c1", "no"), result("c2", "yes")];

    const comparisons = compareBaseline(withSkill, withoutSkill);
    expect(comparisons).toHaveLength(2);
    expect(comparisons[0].skill_adds_value).toBe(true);
    expect(comparisons[1].skill_adds_value).toBe(false);
  });

  it("flags obsolete candidate when baseline matches", () => {
    const comparisons = [
      {
        criterion_id: "c1",
        with_skill: "yes" as const,
        without_skill: "yes" as const,
        skill_adds_value: false,
      },
      {
        criterion_id: "c2",
        with_skill: "yes" as const,
        without_skill: "yes" as const,
        skill_adds_value: false,
      },
    ];

    expect(isObsoleteCandidate(comparisons)).toBe(true);
  });

  it("does not flag when skill adds value", () => {
    const comparisons = [
      {
        criterion_id: "c1",
        with_skill: "yes" as const,
        without_skill: "no" as const,
        skill_adds_value: true,
      },
      {
        criterion_id: "c2",
        with_skill: "yes" as const,
        without_skill: "yes" as const,
        skill_adds_value: false,
      },
    ];

    expect(isObsoleteCandidate(comparisons)).toBe(false);
  });

  it("handles empty comparisons", () => {
    expect(isObsoleteCandidate([])).toBe(false);
  });
});

describe("scoring", () => {
  const criteria = [
    criterion({ id: "c1", description: "Blocker", method: "judge", blocker: true }),
    criterion({ id: "c2", description: "Normal", method: "judge" }),
    criterion({ id: "c3", description: "Also normal", method: "judge" }),
  ];

  it("computes score card", () => {
    const results = [result("c1", "yes"), result("c2", "no"), result("c3", "yes")];
    const score = computeScoreCard(results, criteria);

    expect(score.total_criteria).toBe(3);
    expect(score.passed).toBe(2);
    expect(score.failed).toBe(1);
    expect(score.blocker_failures).toBe(0);
    expect(score.pass_rate).toBeCloseTo(2 / 3);
  });

  it("counts blocker failures", () => {
    const results = [result("c1", "no"), result("c2", "yes"), result("c3", "yes")];
    const score = computeScoreCard(results, criteria);
    expect(score.blocker_failures).toBe(1);
  });

  it("decides SHIP when all pass", () => {
    const score: ReturnType<typeof computeScoreCard> = {
      total_criteria: 3,
      passed: 3,
      failed: 0,
      unsure: 0,
      blocker_failures: 0,
      sacred_regressions: 0,
      pass_rate: 1,
    };
    expect(decideRollout(score)).toBe("ship");
  });

  it("decides BLOCK on blocker failure", () => {
    const score: ReturnType<typeof computeScoreCard> = {
      total_criteria: 3,
      passed: 2,
      failed: 1,
      unsure: 0,
      blocker_failures: 1,
      sacred_regressions: 0,
      pass_rate: 2 / 3,
    };
    expect(decideRollout(score)).toBe("block");
  });

  it("decides BLOCK on sacred regression", () => {
    const score: ReturnType<typeof computeScoreCard> = {
      total_criteria: 3,
      passed: 2,
      failed: 1,
      unsure: 0,
      blocker_failures: 0,
      sacred_regressions: 1,
      pass_rate: 2 / 3,
    };
    expect(decideRollout(score)).toBe("block");
  });

  it("decides OBSOLETE_REVIEW when flagged", () => {
    const score: ReturnType<typeof computeScoreCard> = {
      total_criteria: 3,
      passed: 3,
      failed: 0,
      unsure: 0,
      blocker_failures: 0,
      sacred_regressions: 0,
      pass_rate: 1,
    };
    expect(decideRollout(score, true)).toBe("obsolete_review");
  });

  it("decides WARN on non-blocker failures", () => {
    const score: ReturnType<typeof computeScoreCard> = {
      total_criteria: 3,
      passed: 2,
      failed: 1,
      unsure: 0,
      blocker_failures: 0,
      sacred_regressions: 0,
      pass_rate: 2 / 3,
    };
    expect(decideRollout(score)).toBe("warn");
  });
});

describe("launch report", () => {
  it("builds a complete launch report", () => {
    const score: ReturnType<typeof computeScoreCard> = {
      total_criteria: 3,
      passed: 3,
      failed: 0,
      unsure: 0,
      blocker_failures: 0,
      sacred_regressions: 0,
      pass_rate: 1,
    };

    const report = buildLaunchReport("test-skill", score, [], [], false);
    expect(report.decision).toBe("ship");
    expect(report.skill_name).toBe("test-skill");
    expect(report.reasoning).toContain("Ready to ship");
    expect(report.blockers).toHaveLength(0);
  });

  it("builds a blocked launch report", () => {
    const score: ReturnType<typeof computeScoreCard> = {
      total_criteria: 3,
      passed: 1,
      failed: 2,
      unsure: 0,
      blocker_failures: 1,
      sacred_regressions: 1,
      pass_rate: 1 / 3,
    };

    const regressions = [
      {
        criterion_id: "c1",
        previous_verdict: "yes" as const,
        current_verdict: "no" as const,
        is_sacred: true,
      },
    ];

    const report = buildLaunchReport("test-skill", score, regressions, [], false);
    expect(report.decision).toBe("block");
    expect(report.blockers.length).toBeGreaterThan(0);
    expect(report.reasoning).toContain("blocked");
  });
});
