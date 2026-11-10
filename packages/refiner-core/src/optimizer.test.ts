import { describe, expect, it } from "vitest";
import { bootstrapFromItems } from "./bootstrap.js";
import { makeSkillDoc } from "./apply.js";
import { hashValue } from "./hash.js";
import {
  createRefinerExperiment,
  validateProposedRefinerExperiment,
  type CreateRefinerExperimentInputs,
} from "./optimizer.js";

function fixture(): CreateRefinerExperimentInputs {
  const doc = makeSkillDoc("demo", "Baseline instructions");
  const now = "2026-11-10T12:00:00Z";
  return {
    doc,
    now,
    evalSet: bootstrapFromItems(
      doc,
      "golden",
      [{ id: "case-1", prompt: "A request", expectation: "A result" }],
      { now },
    ),
    editProposal: {
      parent: doc.hash,
      ops: [{ kind: "replace", target: "Baseline", content: "Improved" }],
      refinerModel: "test",
      refinerStrategyId: "test",
      rationale: "Improve",
    },
    targetItemId: "case-1",
    source: { runId: 1, criterionId: "legacy", evidenceHash: "a".repeat(64) },
    change: {
      id: "change-1",
      target_criterion: "legacy",
      change_type: "instruction",
      description: "Improve",
      rationale: "Failure",
      expected_impact: "Pass",
    },
  };
}
describe("Refiner optimizer value bindings", () => {
  it("creates deterministic identities and independent snapshots", () => {
    const inputs = fixture();
    const result = createRefinerExperiment(inputs);
    expect(createRefinerExperiment(inputs)).toEqual(result);
    expect(validateProposedRefinerExperiment(result)).toEqual(result);
    expect(result.experiment.refiner).toEqual({
      skill: inputs.doc.hash,
      evalSet: inputs.evalSet.hash,
      editProposal: hashValue(inputs.editProposal),
    });
    expect(result.candidateDoc.text).toBe("Improved instructions");
    inputs.change.description = "changed";
    expect(result.experiment.proposal.description).toBe("Improve");
  });
  it.each([0, 2])("rejects %i edits", (count) => {
    const inputs = fixture();
    expect(() =>
      createRefinerExperiment({
        ...inputs,
        editProposal: {
          ...inputs.editProposal,
          ops: Array.from({ length: count }, () => inputs.editProposal.ops[0]),
        },
      }),
    ).toThrow(/one atomic/);
  });
  it("rejects stale content, foreign sets, invalid mapping and clock", () => {
    const i = fixture();
    expect(() => createRefinerExperiment({ ...i, doc: { ...i.doc, text: "tampered" } })).toThrow(
      /skill hash/,
    );
    expect(() =>
      createRefinerExperiment({ ...i, evalSet: { ...i.evalSet, hash: "a".repeat(64) } }),
    ).toThrow(/eval set/);
    expect(() => createRefinerExperiment({ ...i, targetItemId: "absent" })).toThrow(
      /target mapping/,
    );
    expect(() =>
      createRefinerExperiment({ ...i, source: { ...i.source, criterionId: "other" } }),
    ).toThrow(/target mapping/);
    expect(() => createRefinerExperiment({ ...i, now: "invalid" })).toThrow(/clock/);
  });
  it("rejects ineffective edits and unreviewed or duplicated items", () => {
    const inputs = fixture();
    expect(() =>
      createRefinerExperiment({
        ...inputs,
        editProposal: {
          ...inputs.editProposal,
          ops: [{ kind: "replace", target: "Baseline", content: "Baseline" }],
        },
      }),
    ).toThrow(/must change/);
    for (const items of [
      [{ id: "case-1", prompt: "Request" }],
      [inputs.evalSet.items[0], inputs.evalSet.items[0]],
    ]) {
      const evalSet = bootstrapFromItems(inputs.doc, "golden", items, { now: inputs.now });
      expect(() => createRefinerExperiment({ ...inputs, evalSet })).toThrow(/reviewed unique/);
    }
  });
  it("rejects altered candidates and resolved records", () => {
    const result = createRefinerExperiment(fixture());
    expect(() => validateProposedRefinerExperiment(null)).toThrow(/missing/);
    expect(() =>
      validateProposedRefinerExperiment({ ...result, candidateDoc: result.doc }),
    ).toThrow(/binding/);
    expect(() => validateProposedRefinerExperiment({ ...result, parent: "prior" })).toThrow(
      /unresolved/,
    );
  });
});
