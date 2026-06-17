import { describe, it, expect } from "vitest";
import { applyEdit, makeSkillDoc, EditApplicationError } from "./apply.js";
import type { EditProposal } from "./types.js";

const DOC_TEXT = `---
name: demo
description: a demo skill
---

# Demo

Use this skill to do the thing.
Always validate input first.
`;

function proposal(doc: ReturnType<typeof makeSkillDoc>, ops: EditProposal["ops"]): EditProposal {
  return {
    parent: doc.hash,
    ops,
    refinerModel: "test-model",
    refinerStrategyId: "test/v1",
    rationale: "test",
  };
}

describe("makeSkillDoc", () => {
  it("computes the doc hash from its text", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(makeSkillDoc("demo", DOC_TEXT).hash).toBe(doc.hash);
  });
});

describe("applyEdit", () => {
  it("applies a replace op and returns a NEW doc with a new hash (append-only)", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const p = proposal(doc, [
      { kind: "replace", target: "do the thing", content: "accomplish the task" },
    ]);
    const v2 = applyEdit(doc, p);
    expect(v2.text).toContain("accomplish the task");
    expect(v2.text).not.toContain("do the thing");
    expect(v2.hash).not.toBe(doc.hash);
    // input is untouched
    expect(doc.text).toContain("do the thing");
  });

  it("applies an add op after an exact anchor", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const p = proposal(doc, [
      { kind: "add", after: "Always validate input first.", content: "\nThen log the result." },
    ]);
    const v2 = applyEdit(doc, p);
    expect(v2.text).toContain("Always validate input first.\nThen log the result.");
  });

  it("applies a delete op", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const p = proposal(doc, [{ kind: "delete", target: "\nAlways validate input first." }]);
    const v2 = applyEdit(doc, p);
    expect(v2.text).not.toContain("Always validate input first.");
  });

  it("applies multiple ops in order", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const p = proposal(doc, [
      { kind: "replace", target: "demo skill", content: "demonstration skill" },
      { kind: "add", after: "# Demo", content: "\n\nA worked example." },
    ]);
    const v2 = applyEdit(doc, p);
    expect(v2.text).toContain("demonstration skill");
    expect(v2.text).toContain("# Demo\n\nA worked example.");
  });

  it("throws when the proposal parent does not match the doc hash", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const stale: EditProposal = {
      parent: "0".repeat(64),
      ops: [{ kind: "delete", target: "# Demo" }],
      refinerModel: "test-model",
      refinerStrategyId: "test/v1",
      rationale: "test",
    };
    expect(() => applyEdit(doc, stale)).toThrow(EditApplicationError);
  });

  it("throws when an anchor is not found", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const p = proposal(doc, [{ kind: "delete", target: "nonexistent substring" }]);
    expect(() => applyEdit(doc, p)).toThrow(/not found/);
  });

  it("throws when an anchor is ambiguous (appears more than once)", () => {
    const doc = makeSkillDoc("demo", "alpha beta alpha");
    const p = proposal(doc, [{ kind: "replace", target: "alpha", content: "gamma" }]);
    expect(() => applyEdit(doc, p)).toThrow(/ambiguous/);
  });

  it("throws on an empty anchor", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const p = proposal(doc, [{ kind: "delete", target: "" }]);
    expect(() => applyEdit(doc, p)).toThrow(/empty/);
  });
});
