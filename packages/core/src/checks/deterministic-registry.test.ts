import { describe, it, expect } from "vitest";
import { runCheck, listChecks, registerCheck } from "./deterministic-registry.js";

describe("deterministic check registry", () => {
  it("lists built-in checks", () => {
    const checks = listChecks();
    expect(checks).toContain("contains");
    expect(checks).toContain("not_contains");
    expect(checks).toContain("regex_match");
    expect(checks).toContain("min_length");
    expect(checks).toContain("max_length");
    expect(checks).toContain("not_empty");
  });

  it("contains check passes when value found", () => {
    const result = runCheck("contains", "hello world", { value: "world" });
    expect(result.severity).toBe("pass");
  });

  it("contains check fails when value not found", () => {
    const result = runCheck("contains", "hello world", { value: "missing" });
    expect(result.severity).toBe("error");
  });

  it("not_contains check passes when value absent", () => {
    const result = runCheck("not_contains", "hello world", { value: "missing" });
    expect(result.severity).toBe("pass");
  });

  it("not_contains check fails when value present", () => {
    const result = runCheck("not_contains", "hello world", { value: "world" });
    expect(result.severity).toBe("error");
  });

  it("regex_match check passes on matching pattern", () => {
    const result = runCheck("regex_match", "Error: 404 Not Found", { pattern: "\\d{3}" });
    expect(result.severity).toBe("pass");
  });

  it("regex_match check fails on non-matching pattern", () => {
    const result = runCheck("regex_match", "all good", { pattern: "\\d{3}" });
    expect(result.severity).toBe("error");
  });

  it("min_length check passes for long enough input", () => {
    const result = runCheck("min_length", "hello", { min: 3 });
    expect(result.severity).toBe("pass");
  });

  it("min_length check fails for too short input", () => {
    const result = runCheck("min_length", "hi", { min: 5 });
    expect(result.severity).toBe("error");
  });

  it("not_empty check passes for non-empty input", () => {
    const result = runCheck("not_empty", "content");
    expect(result.severity).toBe("pass");
  });

  it("not_empty check fails for empty/whitespace input", () => {
    const result = runCheck("not_empty", "   ");
    expect(result.severity).toBe("error");
  });

  it("contains check fails CLOSED when params.value is missing [f-jrig-core-1]", () => {
    const result = runCheck("contains", "any output at all");
    expect(result.severity).toBe("error");
    expect(result.message).toContain("requires params.value");
  });

  it("not_contains check fails CLOSED when params.value is missing [f-jrig-core-1]", () => {
    const result = runCheck("not_contains", "any output at all");
    expect(result.severity).toBe("error");
    expect(result.message).toContain("requires params.value");
  });

  it("regex_match check fails CLOSED when params.pattern is missing [f-jrig-core-1]", () => {
    const result = runCheck("regex_match", "any output at all");
    expect(result.severity).toBe("error");
    expect(result.message).toContain("requires params.pattern");
  });

  it("min_length check fails CLOSED when params.min is missing [f-jrig-core-1]", () => {
    const result = runCheck("min_length", "any output at all");
    expect(result.severity).toBe("error");
    expect(result.message).toContain("requires params.min");
  });

  it("max_length check fails CLOSED when params.max is missing [f-jrig-core-1]", () => {
    const result = runCheck("max_length", "any output at all");
    expect(result.severity).toBe("error");
    expect(result.message).toContain("requires params.max");
  });

  it("returns error for unknown check name", () => {
    const result = runCheck("nonexistent_check", "test");
    expect(result.severity).toBe("error");
    expect(result.message).toContain("Unknown");
  });

  it("allows registering custom checks", () => {
    registerCheck("custom_test", (input) => input === "magic");
    const pass = runCheck("custom_test", "magic");
    const fail = runCheck("custom_test", "nope");
    expect(pass.severity).toBe("pass");
    expect(fail.severity).toBe("error");
  });
});
