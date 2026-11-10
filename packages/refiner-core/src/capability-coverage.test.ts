import { describe, expect, it } from "vitest";
import { capabilityCoverage, type CapabilityManifest } from "./capability-coverage.js";
import { coverage, evaluateEvalSet } from "./eval-set-metrics.js";
import { bootstrap } from "./bootstrap.js";
import { hashSkillDoc } from "./hash.js";

const text = "# Demo\n\nHandle reading, writing, and recovery.";
const evalSet = {
  ...bootstrap(
    { skillId: "demo", text, hash: hashSkillDoc(text) },
    { now: "2026-11-10T00:00:00Z" },
  ),
  items: [
    { id: "read-001", prompt: "Read." },
    { id: "write-001", prompt: "Write." },
  ],
};
const manifest: CapabilityManifest = {
  skillId: evalSet.skillId,
  evalSetHash: evalSet.hash,
  capabilities: [
    { id: "read", minimumItems: 1 },
    { id: "write", minimumItems: 1 },
    { id: "recovery", minimumItems: 1 },
  ],
  assignments: [
    { itemId: "read-001", capabilityIds: ["read"] },
    { itemId: "write-001", capabilityIds: ["write"] },
  ],
};

describe("declared capability coverage", () => {
  it("detects an absent capability even when observed entropy is perfect", () => {
    expect(coverage(evalSet).score).toBe(1);
    const result = capabilityCoverage(evalSet, manifest);
    expect(result.completeness).toBeCloseTo(2 / 3);
    expect(result.complete).toBe(false);
    expect(result.strata[2]).toEqual({ id: "recovery", required: 1, observed: 0, missing: 1 });
  });

  it("requires the declared sample count, not just one example per capability", () => {
    const result = capabilityCoverage(evalSet, {
      ...manifest,
      capabilities: [
        { id: "read", minimumItems: 2 },
        { id: "write", minimumItems: 1 },
      ],
    });
    expect(result.completeness).toBe(0.5);
    expect(result.strata[0].missing).toBe(1);
  });

  it("reports every capability missing for an empty set", () => {
    const result = capabilityCoverage({ ...evalSet, items: [] }, { ...manifest, assignments: [] });
    expect(result.completeness).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.strata.map((s) => s.missing)).toEqual([1, 1, 1]);
  });

  it("allows explicit multi-capability items without inventing a category from their id", () => {
    const result = capabilityCoverage(evalSet, {
      ...manifest,
      assignments: [
        manifest.assignments[0],
        { itemId: "write-001", capabilityIds: ["write", "recovery"] },
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.completeness).toBe(1);
  });

  it("does not declare full coverage while items have no reviewed assignment", () => {
    const result = capabilityCoverage(evalSet, {
      ...manifest,
      capabilities: [{ id: "read", minimumItems: 1 }],
      assignments: [manifest.assignments[0]],
    });
    expect(result.completeness).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.unassignedItemIds).toEqual(["write-001"]);
  });

  it.each([
    { ...manifest, skillId: "other" },
    { ...manifest, evalSetHash: "foreign" },
    { ...manifest, capabilities: [] },
    { ...manifest, capabilities: [manifest.capabilities[0], manifest.capabilities[0]] },
    { ...manifest, capabilities: [{ id: "read", minimumItems: 0 }] },
    { ...manifest, capabilities: [{ id: "read", minimumItems: NaN }] },
    { ...manifest, capabilities: [{ id: " ", minimumItems: 1 }] },
    { ...manifest, assignments: [manifest.assignments[0], manifest.assignments[0]] },
    { ...manifest, assignments: [{ itemId: "unknown", capabilityIds: ["read"] }] },
    { ...manifest, assignments: [{ itemId: "read-001", capabilityIds: ["unknown"] }] },
    { ...manifest, assignments: [{ itemId: "read-001", capabilityIds: [] }] },
    { ...manifest, assignments: [{ itemId: "read-001", capabilityIds: ["read", "read"] }] },
  ])("refuses ambiguous or unbound declarations %#", (invalid) => {
    expect(() => capabilityCoverage(evalSet, invalid)).toThrow(RangeError);
  });

  it("rejects duplicate eval item identities", () => {
    expect(() =>
      capabilityCoverage({ ...evalSet, items: [evalSet.items[0], evalSet.items[0]] }, manifest),
    ).toThrow(RangeError);
  });

  it("integrates declared completeness without relabeling legacy entropy", () => {
    const report = evaluateEvalSet(evalSet, { capabilityManifest: manifest });
    expect(report.coverage.score).toBe(1);
    expect(report.capabilityCoverage?.complete).toBe(false);
    expect(evaluateEvalSet(evalSet).capabilityCoverage).toBeUndefined();
  });
});
