import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalContractSchema } from "./eval-contract.js";
import { parseAndValidateYaml } from "../parsers/yaml-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../fixtures");

function readFixture(path: string): string {
  return readFileSync(resolve(fixturesDir, path), "utf-8");
}

describe("EvalContractSchema", () => {
  it("parses a valid eval contract fixture", () => {
    const yaml = readFixture("valid/eval-contract.yaml");
    const result = parseAndValidateYaml(yaml, EvalContractSchema);
    if (!result.success) {
      throw new Error(`Parse failed: ${JSON.stringify(result.errors, null, 2)}`);
    }
    expect(result.data.skill_name).toBe("commit-message-writer");
    expect(result.data.purpose).toBeTruthy();
    expect(result.data.trigger_boundary.should_trigger.length).toBeGreaterThan(0);
    expect(result.data.trigger_boundary.should_not_trigger.length).toBeGreaterThan(0);
    expect(result.data.blockers.length).toBeGreaterThan(0);
  });

  it("requires trigger_boundary with both arrays", () => {
    const result = EvalContractSchema.safeParse({
      contract_version: "1.0",
      skill_name: "test-skill",
      purpose: "test",
      success_criteria: ["works"],
      blockers: ["breaks"],
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one should_trigger entry", () => {
    const result = EvalContractSchema.safeParse({
      contract_version: "1.0",
      skill_name: "test-skill",
      purpose: "test",
      trigger_boundary: {
        should_trigger: [],
        should_not_trigger: ["something"],
      },
      success_criteria: ["works"],
      blockers: ["breaks"],
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one blocker", () => {
    const result = EvalContractSchema.safeParse({
      contract_version: "1.0",
      skill_name: "test-skill",
      purpose: "test",
      trigger_boundary: {
        should_trigger: ["do it"],
        should_not_trigger: ["don't"],
      },
      success_criteria: ["works"],
      blockers: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields from fixture", () => {
    const yaml = readFixture("invalid/eval-contract-missing-fields.yaml");
    const result = parseAndValidateYaml(yaml, EvalContractSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("allows optional safety_boundaries and baseline_expectation", () => {
    const result = EvalContractSchema.safeParse({
      contract_version: "1.0",
      skill_name: "test-skill",
      purpose: "test",
      trigger_boundary: {
        should_trigger: ["do it"],
        should_not_trigger: ["don't"],
      },
      success_criteria: ["works"],
      blockers: ["fails"],
    });
    expect(result.success).toBe(true);
  });
});
