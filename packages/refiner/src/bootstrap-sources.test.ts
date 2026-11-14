import { describe, expect, it } from "vitest";
import { hashValue, makeSkillDoc } from "@intentsolutions/refiner-core";
import { assessProposal } from "./assess.js";
import type { EvalInvocation } from "./score.js";
import { bootstrapReviewedSource } from "./bootstrap-sources.js";

const doc = makeSkillDoc("demo", "# Demo\nFollow explicit instructions.");
const opts = { now: "2026-11-10T12:00:00Z" };
function fixture(kind: "golden" | "harvested") {
  const trace = { id: "case", prompt: "A request", output: "Observed, not an expectation" };
  const source =
    kind === "golden"
      ? {
          schema: "j-rig/golden-traces/v1",
          skillId: doc.skillId,
          skillHash: doc.hash,
          items: [trace],
        }
      : {
          schema: "j-rig/rollouts/v1",
          skillId: doc.skillId,
          skillHash: doc.hash,
          status: "completed",
          runs: [
            {
              runId: 1,
              model: "test-model",
              provider: "openai",
              groundTruth: true,
              status: "completed",
              outcomes: [{ ...trace, status: "completed" }],
            },
          ],
        };
  const review = {
    schema: "j-rig/bootstrap-review/v1",
    skillId: doc.skillId,
    skillHash: doc.hash,
    sourceHash: hashValue(source),
    reviewed: true,
    reviewedAt: "2026-11-09T12:00:00Z",
    items: [
      { id: kind === "golden" ? "case" : "run-1:case", expectation: "Explicit expected behavior" },
    ],
  };
  return { source, review };
}

describe("reviewed source bootstrap", () => {
  it.each(["golden", "harvested"] as const)(
    "preserves %s provenance, review labels and determinism",
    (kind) => {
      const { source, review } = fixture(kind);
      const result = bootstrapReviewedSource(doc, source, review, kind, opts);
      expect(result).toEqual(bootstrapReviewedSource(doc, source, review, kind, opts));
      expect(result.source).toBe(kind);
      expect(result.items[0]).toMatchObject({
        expectation: review.items[0].expectation,
        provenance: { sourceHash: hashValue(source), reviewHash: hashValue(review) },
      });
      expect(result.refreshDueAt).toBe("2027-02-08T12:00:00.000Z");
      const changed = {
        ...review,
        items: [{ ...review.items[0], expectation: "Different label" }],
      };
      expect(bootstrapReviewedSource(doc, source, changed, kind, opts).hash).not.toBe(result.hash);
      expect(
        bootstrapReviewedSource(doc, source, review, kind, { ...opts, quick: true }).refreshDueAt,
      ).toBeNull();
    },
  );

  it.each([
    ["unreviewed", { reviewed: false }],
    ["foreign review", { skillHash: "foreign" }],
    ["source mismatch", { sourceHash: "foreign" }],
    ["invalid time", { reviewedAt: "not-a-date" }],
    ["future review", { reviewedAt: "2027-01-01" }],
    ["empty labels", { items: [] }],
    ["missing expectation", { items: [{ id: "case" }] }],
    ["unknown item", { items: [{ id: "unknown", expectation: "label" }] }],
    [
      "duplicate labels",
      {
        items: [
          { id: "case", expectation: "a" },
          { id: "case", expectation: "b" },
        ],
      },
    ],
  ])("rejects %s", (_name, change) => {
    const { source, review } = fixture("golden");
    expect(() =>
      bootstrapReviewedSource(doc, source, { ...review, ...change }, "golden", opts),
    ).toThrow();
  });

  it.each(["status", "groundTruth", "provider", "outcome", "runId", "duplicate-run"])(
    "rejects invalid harvested %s",
    (field) => {
      const { source, review } = fixture("harvested");
      if (!("runs" in source) || !source.runs) throw new Error("missing runs");
      const run = source.runs[0];
      if (field === "status") run.status = "failed";
      if (field === "groundTruth") run.groundTruth = false;
      if (field === "provider") run.provider = "stub";
      if (field === "outcome") run.outcomes[0].status = "timed_out";
      if (field === "runId") run.runId = 0;
      if (field === "duplicate-run") source.runs.push(run);
      expect(() =>
        bootstrapReviewedSource(
          doc,
          source,
          { ...review, sourceHash: hashValue(source) },
          "harvested",
          opts,
        ),
      ).toThrow();
    },
  );

  it.each([null, [], {}, { schema: "wrong" }])("refuses malformed source %j", (source) => {
    expect(() =>
      bootstrapReviewedSource(doc, source, fixture("golden").review, "golden", opts),
    ).toThrow();
  });
});

it.each(["golden", "harvested"] as const)(
  "carries reviewed adversarial labels from %s into assessment",
  async (kind) => {
    const { source, review } = fixture(kind);
    const reviewed = {
      ...review,
      items: review.items.map((item) => ({ ...item, adversarial: true })),
    };
    const set = bootstrapReviewedSource(doc, source, reviewed, kind, opts);
    expect(set.items[0].adversarial).toBe(true);
    expect(set.hash).not.toBe(bootstrapReviewedSource(doc, source, review, kind, opts).hash);
    const result = await assessProposal(
      {
        doc,
        evalSet: set,
        now: opts.now,
        proposal: {
          parent: doc.hash,
          ops: [{ kind: "replace", target: "explicit", content: "precise" }],
          refinerModel: "m",
          refinerStrategyId: "test",
          rationale: "test",
        },
        scoreOptions: { skillDir: "/unused", modelTier: "m" },
        policy: {
          maxLeakage: 0,
          maxDuplicateRatio: 0,
          maxBrierScore: 0,
          maxEce: 0,
          minCalibrationSamples: 1,
          minAdversarialItems: 1,
        },
        quality: {
          evalSetHash: set.hash,
          verifiedEvalSet: true,
          reviewedAt: review.reviewedAt,
          expiresAt: "2026-12-01T00:00:00Z",
          judge: { provider: "fixture", model: "judge" },
          referenceItems: [{ id: "ref", prompt: "Different reference prompt" }],
          predictions: [{ confidence: 1, correct: true }],
          manifest: {
            skillId: doc.skillId,
            evalSetHash: set.hash,
            capabilities: [{ id: "task", minimumItems: 1 }],
            assignments: [{ itemId: set.items[0].id, capabilityIds: ["task"] }],
          },
        },
      },
      {
        run: async (invocation: EvalInvocation) => ({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            m: {
              ground_truth: true,
              judge_provider: "fixture",
              judge_model: "judge",
              criterion_results: [
                {
                  criterion_id: "refiner-item-0",
                  test_case_id: invocation.evalSet.items[0].id,
                  verdict: "yes",
                },
              ],
              scoreCard: { total_criteria: 1, passed: 1, pass_rate: 1 },
            },
          }),
        }),
      },
      { validate: () => ({ valid: true }) },
    );
    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") throw new Error("expected paired evaluation");
    expect(result.baseline.record.dimensions.adversarial_pass_rate.n).toBe(1);
  },
);

it("rejects non-boolean adversarial review labels", () => {
  const { source, review } = fixture("golden");
  expect(() =>
    bootstrapReviewedSource(
      doc,
      source,
      { ...review, items: review.items.map((item) => ({ ...item, adversarial: "true" })) },
      "golden",
      opts,
    ),
  ).toThrow(/boolean/);
});
