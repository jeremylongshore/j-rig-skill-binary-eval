import { describe, it, expect } from "vitest";
import { clusterFailures, selectWeakest } from "./clustering.js";
import { createExperiment, evaluateExperiment, shouldStop } from "./experiment.js";
import { CriterionSchema } from "../schemas/criterion.js";
import type { Criterion } from "../schemas/criterion.js";
import type { JudgmentResult } from "../judgment/types.js";
import type { ChangeProposal, Experiment } from "./types.js";

function criterion(partial: {
  id: string;
  description: string;
  method: "deterministic" | "judge";
  blocker?: boolean;
  regression_critical?: boolean;
  deterministic_check?: string;
}): Criterion {
  return CriterionSchema.parse(partial);
}

function result(id: string, verdict: "yes" | "no" | "unsure"): JudgmentResult {
  return { criterion_id: id, verdict, confidence: 1, reasoning: "", method: "judge" };
}

describe("failure clustering", () => {
  const criteria = [
    criterion({ id: "c1", description: "Blocker check", method: "judge", blocker: true }),
    criterion({ id: "c2", description: "Normal judge", method: "judge" }),
    criterion({
      id: "c3",
      description: "Det check",
      method: "deterministic",
      deterministic_check: "not_empty",
    }),
    criterion({ id: "c4", description: "Another judge", method: "judge" }),
  ];

  it("clusters failures by method", () => {
    const results = [
      result("c1", "no"),
      result("c2", "no"),
      result("c3", "no"),
      result("c4", "yes"),
    ];
    const clusters = clusterFailures(results, criteria);

    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const judgeCluster = clusters.find((c) => c.pattern === "judge failures");
    expect(judgeCluster?.count).toBe(2);
  });

  it("marks clusters with blockers as critical", () => {
    const results = [result("c1", "no"), result("c2", "yes"), result("c3", "yes")];
    const clusters = clusterFailures(results, criteria);
    expect(clusters[0].severity).toBe("critical");
  });

  it("returns empty for no failures", () => {
    const results = [result("c1", "yes"), result("c2", "yes")];
    expect(clusterFailures(results, criteria)).toHaveLength(0);
  });
});

describe("selectWeakest", () => {
  const criteria = [
    criterion({ id: "c1", description: "Blocker", method: "judge", blocker: true }),
    criterion({ id: "c2", description: "Regression", method: "judge", regression_critical: true }),
    criterion({ id: "c3", description: "Normal", method: "judge" }),
  ];

  it("selects blocker failure first", () => {
    const results = [result("c1", "no"), result("c2", "no"), result("c3", "no")];
    expect(selectWeakest(results, criteria)).toBe("c1");
  });

  it("selects regression-critical when no blocker", () => {
    const results = [result("c1", "yes"), result("c2", "no"), result("c3", "no")];
    expect(selectWeakest(results, criteria)).toBe("c2");
  });

  it("selects first failure when no priority", () => {
    const results = [result("c1", "yes"), result("c2", "yes"), result("c3", "no")];
    expect(selectWeakest(results, criteria)).toBe("c3");
  });

  it("returns null when all pass", () => {
    const results = [result("c1", "yes"), result("c2", "yes")];
    expect(selectWeakest(results, criteria)).toBeNull();
  });
});

describe("experiment lifecycle", () => {
  const proposal: ChangeProposal = {
    id: "p1",
    target_criterion: "c1",
    change_type: "instruction",
    description: "Add explicit format instruction",
    rationale: "Output format was wrong",
    expected_impact: "c1 should now pass",
  };

  it("creates an experiment from proposal", () => {
    const before = [result("c1", "no"), result("c2", "yes")];
    const exp = createExperiment(proposal, before);
    expect(exp.status).toBe("proposed");
    expect(exp.proposal.target_criterion).toBe("c1");
    expect(exp.before_results).toHaveLength(2);
  });

  it("accepts when target passes and no regressions", () => {
    const before = [result("c1", "no"), result("c2", "yes")];
    const exp = createExperiment(proposal, before);
    const after = [result("c1", "yes"), result("c2", "yes")];
    expect(evaluateExperiment(exp, after)).toBe("accepted");
  });

  it("rejects when target still fails", () => {
    const before = [result("c1", "no"), result("c2", "yes")];
    const exp = createExperiment(proposal, before);
    const after = [result("c1", "no"), result("c2", "yes")];
    expect(evaluateExperiment(exp, after)).toBe("rejected");
  });

  it("rejects when target passes but another regresses", () => {
    const before = [result("c1", "no"), result("c2", "yes")];
    const exp = createExperiment(proposal, before);
    const after = [result("c1", "yes"), result("c2", "no")];
    expect(evaluateExperiment(exp, after)).toBe("rejected");
  });
});

describe("early stopping", () => {
  it("stops when all criteria pass", () => {
    const results = [result("c1", "yes"), result("c2", "yes")];
    const { stop, reason } = shouldStop(results, []);
    expect(stop).toBe(true);
    expect(reason).toContain("All criteria pass");
  });

  it("stops at max experiments", () => {
    const results = [result("c1", "no")];
    const history = Array.from({ length: 10 }, () => ({
      id: "e",
      proposal: {} as ChangeProposal,
      status: "rejected" as const,
      improvement: null,
      created_at: "",
    }));
    const { stop } = shouldStop(results, history);
    expect(stop).toBe(true);
  });

  it("stops on optimization resistance", () => {
    const results = [result("c1", "no")];
    const history: Experiment[] = [
      {
        id: "1",
        proposal: {} as ChangeProposal,
        status: "rejected",
        improvement: null,
        created_at: "",
      },
      {
        id: "2",
        proposal: {} as ChangeProposal,
        status: "rejected",
        improvement: null,
        created_at: "",
      },
      {
        id: "3",
        proposal: {} as ChangeProposal,
        status: "rejected",
        improvement: null,
        created_at: "",
      },
    ];
    const { stop, reason } = shouldStop(results, history);
    expect(stop).toBe(true);
    expect(reason).toContain("resistance");
  });

  it("continues when work remains", () => {
    const results = [result("c1", "no")];
    const { stop } = shouldStop(results, []);
    expect(stop).toBe(false);
  });
});
