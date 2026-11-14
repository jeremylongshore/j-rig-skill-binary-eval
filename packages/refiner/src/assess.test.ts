import { describe, expect, it, vi } from "vitest";
import {
  bootstrap,
  hashValue,
  makeSkillDoc,
  MAX_OPS_PER_PROPOSAL,
} from "@intentsolutions/refiner-core";
import { assessProposal, type AssessProposalInputs } from "./assess.js";
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

describe("quality-gated proposal assessment", () => {
  it("scores both frozen versions afresh and invokes the real decision gate", async () => {
    const inputs = fixture();
    const runner = evaluator();
    const result = await assessProposal(inputs, runner, validSchema);
    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") throw new Error("expected evaluated result");
    expect(result.decision.outcome).toBe("ACCEPT");
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runner.run.mock.calls[0][0].doc.hash).toBe(doc.hash);
    expect(runner.run.mock.calls[1][0].doc.hash).toBe(result.candidateDoc.hash);
    expect(result.baseline.record.evalSet).toBe(inputs.evalSet.hash);
    expect(result.candidate.record.evalSet).toBe(inputs.evalSet.hash);
    expect(result.qualityReport.capabilityCoverage?.complete).toBe(true);
    expect(result.qualityReport.adversarialPassRate?.rate).toBe(0.5);
    expect(result.qualityEvidenceHash).toBe(hashValue(inputs.quality));
    expect(result.policyHash).toBe(hashValue(inputs.policy));
  });

  it.each([0, MAX_OPS_PER_PROPOSAL + 1])("blocks %i operations before scoring", async (count) => {
    const inputs = fixture();
    const runner = evaluator();
    const ops = Array.from({ length: count }, (_, i) => ({
      kind: "replace" as const,
      target: i === 0 ? "Baseline" : `Improved-${i - 1}`,
      content: `Improved-${i}`,
    }));
    expect(
      await assessProposal(
        { ...inputs, proposal: { ...inputs.proposal, ops } },
        runner,
        validSchema,
      ),
    ).toEqual({ status: "blocked", reasons: ["invalid-proposal-operation-count"] });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("pins both evaluations to the reviewed judge rather than caller overrides", async () => {
    const inputs = fixture();
    const runner = evaluator();
    await assessProposal(
      {
        ...inputs,
        scoreOptions: {
          ...inputs.scoreOptions,
          judgeProvider: "other-provider",
          judgeModel: "other-model",
        },
      },
      runner,
      validSchema,
    );
    expect(runner.run).toHaveBeenCalledTimes(2);
    for (const [invocation] of runner.run.mock.calls) {
      expect(invocation).toMatchObject({ judgeProvider: "test-judge", judgeModel: "judge-v1" });
    }
  });

  it("rejects a significant adversarial regression despite overall improvement", async () => {
    const result = await assessProposal(fixture(), evaluator(true), validSchema);
    expect(result).toMatchObject({
      status: "evaluated",
      decision: { outcome: "REJECT", judgeReason: "pareto-incomparable" },
    });
  });

  it("uses the kernel schema validator by default rather than silently accepting invalid text", async () => {
    const result = await assessProposal(fixture(), evaluator());
    expect(result).toMatchObject({
      status: "evaluated",
      decision: { outcome: "LOG_TO_SCHEMA_REVISION_CANDIDATES" },
    });
  });

  it.each([
    ["missing evidence", (i: AssessProposalInputs) => ({ ...i, quality: undefined })],
    [
      "foreign evidence",
      (i: AssessProposalInputs) => ({ ...i, quality: { ...i.quality!, evalSetHash: "foreign" } }),
    ],
    [
      "expired review",
      (i: AssessProposalInputs) => ({ ...i, quality: { ...i.quality!, expiresAt: now } }),
    ],
    [
      "future review",
      (i: AssessProposalInputs) => ({
        ...i,
        quality: { ...i.quality!, reviewedAt: "2027-01-01T00:00:00Z" },
      }),
    ],
    ["invalid clock", (i: AssessProposalInputs) => ({ ...i, now: "invalid" })],
    [
      "absent reference",
      (i: AssessProposalInputs) => ({ ...i, quality: { ...i.quality!, referenceItems: [] } }),
    ],
    [
      "leakage",
      (i: AssessProposalInputs) => ({
        ...i,
        quality: { ...i.quality!, referenceItems: [i.evalSet.items[0]] },
      }),
    ],
    [
      "absent calibration",
      (i: AssessProposalInputs) => ({ ...i, quality: { ...i.quality!, predictions: [] } }),
    ],
    [
      "bad calibration",
      (i: AssessProposalInputs) => ({
        ...i,
        quality: {
          ...i.quality!,
          predictions: Array.from({ length: 10 }, () => ({ confidence: 1, correct: false })),
        },
      }),
    ],
    [
      "invalid confidence",
      (i: AssessProposalInputs) => ({
        ...i,
        quality: {
          ...i.quality!,
          predictions: Array.from({ length: 10 }, () => ({ confidence: NaN, correct: true })),
        },
      }),
    ],
    [
      "missing capability",
      (i: AssessProposalInputs) => ({
        ...i,
        quality: {
          ...i.quality!,
          manifest: {
            ...i.quality!.manifest,
            capabilities: [...i.quality!.manifest.capabilities, { id: "missing", minimumItems: 1 }],
          },
        },
      }),
    ],
    [
      "unassigned items",
      (i: AssessProposalInputs) => ({
        ...i,
        quality: { ...i.quality!, manifest: { ...i.quality!.manifest, assignments: [] } },
      }),
    ],
    [
      "foreign manifest",
      (i: AssessProposalInputs) => ({
        ...i,
        quality: { ...i.quality!, manifest: { ...i.quality!.manifest, evalSetHash: "foreign" } },
      }),
    ],
    [
      "insufficient adversarial set",
      (i: AssessProposalInputs) => ({ ...i, policy: { ...i.policy, minAdversarialItems: 11 } }),
    ],
    [
      "invalid policy",
      (i: AssessProposalInputs) => ({ ...i, policy: { ...i.policy, maxLeakage: NaN } }),
    ],
    [
      "zero sample policy",
      (i: AssessProposalInputs) => ({ ...i, policy: { ...i.policy, minCalibrationSamples: 0 } }),
    ],
  ] as const)("blocks %s before any evaluator call", async (_name, change) => {
    const runner = evaluator();
    const result = await assessProposal(change(fixture()), runner, validSchema);
    expect(result.status).toBe("blocked");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("allows the shared maximum operation count", async () => {
    const inputs = fixture();
    const ops = Array.from({ length: MAX_OPS_PER_PROPOSAL }, (_, i) => ({
      kind: "replace" as const,
      target: i === 0 ? "Baseline" : `Improved-${i - 1}`,
      content: `Improved-${i}`,
    }));
    const result = await assessProposal(
      { ...inputs, proposal: { ...inputs.proposal, ops } },
      evaluator(),
      validSchema,
    );
    expect(result).toMatchObject({ status: "evaluated", decision: { outcome: "ACCEPT" } });
  });

  it("does not treat a calibrated alias as evidence for a resolved model", async () => {
    const inputs = fixture();
    const runner = evaluator(false, "judge-v2");
    const result = await assessProposal(
      {
        ...inputs,
        quality: {
          ...inputs.quality!,
          judge: { provider: "test-judge", model: "latest" },
        },
      },
      runner,
      validSchema,
    );
    expect(result).toEqual({ status: "blocked", reasons: ["calibrated-judge-mismatch"] });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("checks calibrated judge identity before running the candidate", async () => {
    const runner = evaluator(false, "another-judge");
    expect(await assessProposal(fixture(), runner, validSchema)).toEqual({
      status: "blocked",
      reasons: ["calibrated-judge-mismatch"],
    });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("rejects content tampering and stale proposal parents before evaluation", async () => {
    const inputs = fixture();
    const runner = evaluator();
    await expect(
      assessProposal({ ...inputs, doc: { ...doc, text: "tampered" } }, runner),
    ).rejects.toThrow(/hash/);
    await expect(
      assessProposal({ ...inputs, proposal: { ...inputs.proposal, parent: "foreign" } }, runner),
    ).rejects.toThrow();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("propagates evaluator failure without issuing a decision", async () => {
    const runner = { run: vi.fn(async () => ({ exitCode: 2, stdout: "", stderr: "" })) };
    await expect(assessProposal(fixture(), runner)).rejects.toThrow(/infrastructure/);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("keeps the reviewed evidence and candidate frozen across asynchronous evaluation", async () => {
    const inputs = fixture();
    const original = structuredClone(inputs);
    const underlying = evaluator();
    const runner: EvalRunner = {
      run: async (invocation) => {
        Object.assign(inputs.quality!, { predictions: [], verifiedEvalSet: false });
        Object.assign(inputs.proposal, { parent: "changed-after-start" });
        return underlying.run(invocation);
      },
    };
    const result = await assessProposal(inputs, runner, validSchema);
    expect(result).toMatchObject({ status: "evaluated", decision: { outcome: "ACCEPT" } });
    if (result.status !== "evaluated") throw new Error("missing assessment");
    expect(result.qualityEvidenceHash).toBe(hashValue(original.quality));
    expect(result.proposal.parent).toBe(original.proposal.parent);
  });

  it.each([null, "2026-11-09T00:00:00Z"])(
    "blocks a refresh-due eval set (%s)",
    async (refreshDueAt) => {
      const inputs = fixture();
      const { skillId, source, items, evalSetVersion, lineageParent } = inputs.evalSet;
      const hash = hashValue({
        skillId,
        source,
        items,
        evalSetVersion,
        lineageParent,
        refreshDueAt,
      });
      const runner = evaluator();
      const result = await assessProposal(
        {
          ...inputs,
          evalSet: { ...inputs.evalSet, hash, refreshDueAt },
          quality: {
            ...inputs.quality!,
            evalSetHash: hash,
            manifest: { ...inputs.quality!.manifest, evalSetHash: hash },
          },
        },
        runner,
      );
      expect(result).toEqual({ status: "blocked", reasons: ["eval-set-refresh-due"] });
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate held-out prompts even when the reference set is clean", async () => {
    const inputs = fixture();
    const items = inputs.evalSet.items.map((item, i) => ({
      ...item,
      prompt: i === 1 ? inputs.evalSet.items[0].prompt : item.prompt,
    }));
    const { skillId, source, evalSetVersion, lineageParent, refreshDueAt } = inputs.evalSet;
    const hash = hashValue({ skillId, source, items, evalSetVersion, lineageParent, refreshDueAt });
    const runner = evaluator();
    const result = await assessProposal(
      {
        ...inputs,
        evalSet: { ...inputs.evalSet, items, hash },
        quality: {
          ...inputs.quality!,
          evalSetHash: hash,
          manifest: { ...inputs.quality!.manifest, evalSetHash: hash },
        },
      },
      runner,
    );
    expect(result).toEqual({ status: "blocked", reasons: ["duplicate-eval-prompts"] });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
