import { describe, expect, it, vi } from "vitest";
import {
  bootstrap,
  hashValue,
  makeSkillDoc,
  createRefinerExperiment,
} from "@intentsolutions/refiner-core";
import { type AssessProposalInputs } from "./assess.js";
import type { EvalInvocation, EvalRunner } from "./score.js";

const now = "2026-11-10T12:00:00Z";
const doc = makeSkillDoc("demo", "# Demo\n\nBaseline instructions.");
function fixture(): AssessProposalInputs {
  const base = bootstrap(doc, { now });
  const items = Array.from({ length: 40 }, (_, i) => ({
    id: `case-${i}`,
    prompt: `Request ${i}`,
    expectation: `Correct result ${i}`,
    adversarial: i < 10,
  }));
  const { skillId, source, evalSetVersion, lineageParent, refreshDueAt } = base;
  const evalSet = {
    ...base,
    items,
    hash: hashValue({ skillId, source, items, evalSetVersion, lineageParent, refreshDueAt }),
  };
  return {
    doc,
    evalSet,
    now,
    scoreOptions: { skillDir: "/unused", provider: "openai", modelTier: "test-model" },
    proposal: {
      parent: doc.hash,
      ops: [{ kind: "replace", target: "Baseline", content: "Improved" }],
      refinerModel: "test-model",
      refinerStrategyId: "test",
      rationale: "Test improvement",
    },
    policy: {
      maxLeakage: 0,
      maxDuplicateRatio: 0,
      maxBrierScore: 0.1,
      maxEce: 0.1,
      minCalibrationSamples: 10,
      minAdversarialItems: 10,
    },
    quality: {
      evalSetHash: evalSet.hash,
      verifiedEvalSet: true,
      reviewedAt: "2026-11-09T12:00:00Z",
      expiresAt: "2026-11-11T12:00:00Z",
      judge: { provider: "test-judge", model: "judge-v1" },
      referenceItems: [{ id: "training-1", prompt: "A different training example" }],
      predictions: Array.from({ length: 10 }, () => ({ confidence: 1, correct: true })),
      manifest: {
        skillId,
        evalSetHash: evalSet.hash,
        capabilities: [{ id: "task", minimumItems: 40 }],
        assignments: items.map((item) => ({ itemId: item.id, capabilityIds: ["task"] })),
      },
    },
  };
}

function evaluator(
  regress = false,
  judge = "judge-v1",
): EvalRunner & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async (input: EvalInvocation) => {
      const improved = input.doc.text.includes("Improved");
      const rows = input.evalSet.items.map((item, i) => ({
        criterion_id: `refiner-item-${i}`,
        test_case_id: item.id,
        verdict: (i < 10 ? i < (improved && regress ? 0 : 5) : i < (improved ? 40 : 15))
          ? "yes"
          : "no",
      }));
      const passed = rows.filter((row) => row.verdict === "yes").length;
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          "test-model": {
            ground_truth: true,
            judge_provider: "test-judge",
            judge_model: judge,
            criterion_results: rows,
            scoreCard: { total_criteria: rows.length, passed, pass_rate: passed / rows.length },
          },
        }),
      };
    }),
  };
}
const validSchema = { validate: () => ({ valid: true as const }) };

import { assessOptimizerExperiment } from "./optimizer.js";

function bound(targetItemId = "case-20") {
  const inputs = fixture();
  const experiment = createRefinerExperiment({
    change: {
      id: "change-1",
      target_criterion: "legacy",
      change_type: "instruction",
      description: "Improve instructions",
      rationale: "Observed failure",
      expected_impact: "Target passes",
    },
    doc: inputs.doc,
    evalSet: inputs.evalSet,
    editProposal: inputs.proposal,
    targetItemId,
    source: { runId: 1, criterionId: "legacy", evidenceHash: "a".repeat(64) },
    now,
  });
  return { ...inputs, experiment };
}

describe("optimizer assessment", () => {
  it("resolves an immutable child with paired score identities through the real gate", async () => {
    const inputs = bound();
    const original = structuredClone(inputs.experiment);
    const result = await assessOptimizerExperiment(inputs, evaluator(), validSchema);
    expect(result.experiment).toMatchObject({
      parent: hashValue(original),
      experiment: { status: "accepted", improvement: true },
    });
    expect(inputs.experiment).toEqual(original);
    if (result.assessment.status !== "evaluated") throw new Error("missing assessment");
    expect(result.experiment?.resolution).toEqual({
      assessmentHash: hashValue(result.assessment),
      baselineScoreHash: hashValue(result.assessment.baseline.record),
      candidateScoreHash: hashValue(result.assessment.candidate.record),
      reasons: [],
    });
  });
  it.each(["case-0", "case-7"])(
    "rejects an unimproved target %s despite aggregate acceptance",
    async (target) => {
      const result = await assessOptimizerExperiment(bound(target), evaluator(), validSchema);
      expect(result.assessment).toMatchObject({ decision: { outcome: "ACCEPT" } });
      expect(result.experiment).toMatchObject({
        experiment: { status: "rejected" },
        resolution: { reasons: ["target-did-not-improve"] },
      });
    },
  );
  it("preserves schema rejection even when target and aggregate scores improve", async () => {
    const result = await assessOptimizerExperiment(bound(), evaluator());
    expect(result.experiment).toMatchObject({
      experiment: { status: "rejected" },
      resolution: { reasons: ["refiner-log_to_schema_revision_candidates"] },
    });
  });
  it("rejects a single-item regression masked by improved aggregate scores", async () => {
    const underlying = evaluator();
    const runner: EvalRunner = {
      run: async (input) => {
        const result = await underlying.run(input);
        if (!input.doc.text.includes("Improved")) return result;
        const json = JSON.parse(result.stdout);
        const report = json["test-model"];
        report.criterion_results[10].verdict = "no";
        report.scoreCard.passed -= 1;
        report.scoreCard.pass_rate = report.scoreCard.passed / 40;
        return { ...result, stdout: JSON.stringify(json) };
      },
    };
    const result = await assessOptimizerExperiment(bound(), runner, validSchema);
    expect(result.assessment).toMatchObject({ decision: { outcome: "ACCEPT" } });
    expect(result.experiment).toMatchObject({
      experiment: { status: "rejected" },
      resolution: { reasons: ["criterion-regression"] },
    });
  });
  it("creates no resolution when quality is missing", async () => {
    const runner = evaluator();
    const result = await assessOptimizerExperiment({ ...bound(), quality: undefined }, runner);
    expect(result.assessment.status).toBe("blocked");
    expect(result.experiment).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });
  it("rejects tampered bindings, foreign inputs and earlier clocks before scoring", async () => {
    const runner = evaluator();
    const inputs = bound();
    await expect(
      assessOptimizerExperiment(
        { ...inputs, experiment: { ...inputs.experiment, targetItemId: "case-21" } },
        runner,
      ),
    ).rejects.toThrow(/binding/);
    await expect(
      assessOptimizerExperiment({ ...inputs, doc: makeSkillDoc("demo", "changed") }, runner),
    ).rejects.toThrow(/bound inputs/);
    await expect(
      assessOptimizerExperiment({ ...inputs, now: "2026-11-09T00:00:00Z" }, runner),
    ).rejects.toThrow(/precedes/);
    expect(runner.run).not.toHaveBeenCalled();
  });
});
