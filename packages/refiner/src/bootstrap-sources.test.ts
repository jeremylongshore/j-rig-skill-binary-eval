import { describe, expect, it } from "vitest";
import { hashValue, makeSkillDoc } from "@intentsolutions/refiner-core";
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
