import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalSpecSchema } from "./eval-spec.js";
import { parseAndValidateYaml } from "../parsers/yaml-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../fixtures");

function readFixture(path: string): string {
  return readFileSync(resolve(fixturesDir, path), "utf-8");
}

describe("EvalSpecSchema", () => {
  it("parses a valid eval spec fixture", () => {
    const yaml = readFixture("valid/eval-spec.yaml");
    const result = parseAndValidateYaml(yaml, EvalSpecSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skill_name).toBe("commit-message-writer");
      expect(result.data.criteria.length).toBeGreaterThan(0);
      expect(result.data.test_cases.length).toBeGreaterThan(0);
      expect(result.data.models).toContain("sonnet");
    }
  });

  it("requires spec_version", () => {
    const result = EvalSpecSchema.safeParse({
      skill_name: "test-skill",
      description: "test",
      criteria: [{ id: "c1", description: "test", method: "deterministic" }],
      test_cases: [{ id: "t1", description: "test", tier: "core", prompt: "test" }],
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one criterion", () => {
    const result = EvalSpecSchema.safeParse({
      spec_version: "1.0",
      skill_name: "test-skill",
      description: "test",
      criteria: [],
      test_cases: [{ id: "t1", description: "test", tier: "core", prompt: "test" }],
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one test case", () => {
    const result = EvalSpecSchema.safeParse({
      spec_version: "1.0",
      skill_name: "test-skill",
      description: "test",
      criteria: [{ id: "c1", description: "test", method: "deterministic" }],
      test_cases: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-kebab-case skill names", () => {
    const yaml = readFixture("invalid/eval-spec-bad-name.yaml");
    const result = parseAndValidateYaml(yaml, EvalSpecSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.message.includes("kebab-case"))).toBe(true);
    }
  });

  it("rejects invalid criterion method", () => {
    const yaml = readFixture("invalid/eval-spec-bad-method.yaml");
    const result = parseAndValidateYaml(yaml, EvalSpecSchema);
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const yaml = readFixture("invalid/eval-spec-missing-fields.yaml");
    const result = parseAndValidateYaml(yaml, EvalSpecSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("defaults models to sonnet when not specified", () => {
    const result = EvalSpecSchema.parse({
      spec_version: "1.0",
      skill_name: "test-skill",
      description: "test",
      criteria: [{ id: "c1", description: "test", method: "deterministic" }],
      test_cases: [{ id: "t1", description: "test", tier: "core", prompt: "test" }],
    });
    expect(result.models).toEqual(["sonnet"]);
  });

  it("defaults criterion blocker to false", () => {
    const result = EvalSpecSchema.parse({
      spec_version: "1.0",
      skill_name: "test-skill",
      description: "test",
      criteria: [{ id: "c1", description: "test", method: "judge" }],
      test_cases: [{ id: "t1", description: "test", tier: "core", prompt: "test" }],
    });
    expect(result.criteria[0].blocker).toBe(false);
  });
});
