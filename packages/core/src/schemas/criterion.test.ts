import { describe, it, expect } from "vitest";
import { CriterionSchema } from "./criterion.js";

describe("CriterionSchema deterministic_check validation", () => {
  it("rejects a deterministic criterion with no deterministic_check", () => {
    const result = CriterionSchema.safeParse({
      id: "c1",
      description: "Triggers on cost question",
      method: "deterministic",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("deterministic_check"));
      expect(issue?.message).toBe("deterministic criteria must define deterministic_check");
    }
  });

  it("accepts a deterministic criterion that defines a deterministic_check", () => {
    const result = CriterionSchema.safeParse({
      id: "c1",
      description: "Output is non-empty",
      method: "deterministic",
      deterministic_check: "not_empty",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a judge criterion with no deterministic_check (the refine is method-scoped)", () => {
    const result = CriterionSchema.safeParse({
      id: "c1",
      description: "Engages with the cost question",
      method: "judge",
      judge_prompt: "Does the response engage with the cost question? yes or no.",
    });
    expect(result.success).toBe(true);
  });
});
