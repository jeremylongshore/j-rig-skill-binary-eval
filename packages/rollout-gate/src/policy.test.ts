import { describe, it, expect } from "vitest";
import { parsePolicy, RolloutPolicySchema } from "./policy.js";

describe("parsePolicy", () => {
  it("accepts a minimal policy and applies fail-closed defaults", () => {
    const policy = parsePolicy({ required_gates: ["audit-harness:ci:escape-scan"] });
    expect(policy.required_gates).toEqual(["audit-harness:ci:escape-scan"]);
    expect(policy.forbid_decisions).toEqual(["fail", "error"]);
    expect(policy.advisory_blocks).toBe(false);
    expect(policy.allow_unknown_gates).toBe(true);
  });

  it("accepts explicit knobs", () => {
    const policy = parsePolicy({
      required_gates: ["a:ci:b"],
      forbid_decisions: ["error"],
      advisory_blocks: true,
      allow_unknown_gates: false,
    });
    expect(policy.forbid_decisions).toEqual(["error"]);
    expect(policy.advisory_blocks).toBe(true);
    expect(policy.allow_unknown_gates).toBe(false);
  });

  it("rejects garbage: non-object", () => {
    expect(() => parsePolicy("nope")).toThrow();
    expect(() => parsePolicy(null)).toThrow();
    expect(() => parsePolicy(42)).toThrow();
  });

  it("rejects garbage: missing required_gates", () => {
    expect(() => parsePolicy({})).toThrow();
  });

  it("rejects garbage: wrong field types", () => {
    expect(() => parsePolicy({ required_gates: "a:ci:b" })).toThrow();
    expect(() => parsePolicy({ required_gates: [""] })).toThrow();
    expect(() => parsePolicy({ required_gates: ["a:ci:b"], forbid_decisions: ["pass"] })).toThrow();
    expect(() => parsePolicy({ required_gates: ["a:ci:b"], advisory_blocks: "yes" })).toThrow();
  });

  it("rejects unknown keys (strict schema)", () => {
    expect(() => parsePolicy({ required_gates: ["a:ci:b"], surprise: true })).toThrow();
  });

  it("RolloutPolicySchema is exported and parses the same input", () => {
    const check = RolloutPolicySchema.safeParse({ required_gates: ["a:ci:b"] });
    expect(check.success).toBe(true);
  });
});
