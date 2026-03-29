import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseAndValidateYaml, parseYamlRaw, formatParseErrors } from "./yaml-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../fixtures");

function readFixture(path: string): string {
  return readFileSync(resolve(fixturesDir, path), "utf-8");
}

describe("parseAndValidateYaml", () => {
  const SimpleSchema = z.object({
    name: z.string(),
    count: z.number(),
  });

  it("parses valid YAML against a schema", () => {
    const result = parseAndValidateYaml("name: hello\ncount: 42", SimpleSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("hello");
      expect(result.data.count).toBe(42);
    }
  });

  it("returns errors for invalid YAML syntax", () => {
    const yaml = readFixture("invalid/malformed.yaml");
    const result = parseAndValidateYaml(yaml, SimpleSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0].message).toContain("Invalid YAML");
    }
  });

  it("returns errors for schema validation failures", () => {
    const result = parseAndValidateYaml("name: hello\ncount: not_a_number", SimpleSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.path === "count")).toBe(true);
    }
  });

  it("returns error for empty YAML", () => {
    const result = parseAndValidateYaml("", SimpleSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0].message).toContain("empty");
    }
  });
});

describe("parseYamlRaw", () => {
  it("parses valid YAML without schema", () => {
    const result = parseYamlRaw("key: value\nlist:\n  - a\n  - b");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ key: "value", list: ["a", "b"] });
    }
  });

  it("returns error for malformed YAML", () => {
    const result = parseYamlRaw(readFixture("invalid/malformed.yaml"));
    expect(result.success).toBe(false);
  });
});

describe("formatParseErrors", () => {
  it("formats errors with paths", () => {
    const output = formatParseErrors([
      { path: "name", message: "Required" },
      { path: "count", message: "Expected number" },
    ]);
    expect(output).toContain("name: Required");
    expect(output).toContain("count: Expected number");
  });

  it("formats errors without paths", () => {
    const output = formatParseErrors([{ path: "", message: "Invalid YAML" }]);
    expect(output).toContain("Invalid YAML");
  });
});
