import { describe, it, expect } from "vitest";
import { selectCriteriaForTestCase } from "./criteria-selection.js";
import { CriterionSchema } from "../schemas/criterion.js";
import type { Criterion } from "../schemas/criterion.js";

function criterion(id: string): Criterion {
  return CriterionSchema.parse({
    id,
    description: `criterion ${id}`,
    method: "judge",
  });
}

const ALL: Criterion[] = [criterion("a"), criterion("b"), criterion("c")];

describe("selectCriteriaForTestCase", () => {
  it("returns ALL criteria when criteria_ids is absent (documented default)", () => {
    const selected = selectCriteriaForTestCase(ALL, undefined);
    expect(selected.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("returns only the named criteria when criteria_ids is present", () => {
    const selected = selectCriteriaForTestCase(ALL, ["a", "c"]);
    expect(selected.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("returns NO criteria for an empty criteria_ids list (a control prompt judges nothing)", () => {
    // This is the false-blocker fix: a should_not_trigger control case carries
    // `criteria_ids: []` so no off-topic functional criterion is judged against
    // it. An empty list is meaningful — distinct from absent.
    const selected = selectCriteriaForTestCase(ALL, []);
    expect(selected).toEqual([]);
  });

  it("preserves the spec's criteria order, not the criteria_ids order", () => {
    const selected = selectCriteriaForTestCase(ALL, ["c", "a"]);
    expect(selected.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("throws on an unknown id rather than silently under-evaluating", () => {
    // A renamed/misspelled criterion id would otherwise scope a test case to
    // fewer criteria than intended — a silent test gap. Fail loud.
    expect(() => selectCriteriaForTestCase(ALL, ["a", "does-not-exist"])).toThrow(
      "Test case references unknown criteria_ids: does-not-exist",
    );
  });

  it("never mutates the input criteria array", () => {
    const input = [...ALL];
    selectCriteriaForTestCase(input, ["b"]);
    expect(input.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});
