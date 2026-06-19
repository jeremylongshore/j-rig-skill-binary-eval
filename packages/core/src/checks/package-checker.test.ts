import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackage } from "./package-checker.js";
import { formatReport } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../fixtures/packages");

function fixture(name: string): string {
  return resolve(fixturesDir, name);
}

describe("checkPackage", () => {
  it("passes a valid skill package", () => {
    const report = checkPackage(fixture("valid-skill"));
    expect(report.summary.errors).toBe(0);
    expect(report.skill_name).toBe("commit-message-writer");
    expect(
      report.results.some((r) => r.id === "pkg:skill-md-exists" && r.severity === "pass"),
    ).toBe(true);
    expect(
      report.results.some((r) => r.id === "pkg:skill-md-parses" && r.severity === "pass"),
    ).toBe(true);
  });

  it("fails on missing SKILL.md", () => {
    const report = checkPackage(fixture("missing-skill"));
    expect(report.summary.errors).toBeGreaterThan(0);
    expect(report.skill_name).toBeNull();
    expect(
      report.results.some((r) => r.id === "pkg:skill-md-exists" && r.severity === "error"),
    ).toBe(true);
  });

  it("fails on broken frontmatter", () => {
    const report = checkPackage(fixture("broken-frontmatter"));
    expect(report.summary.errors).toBeGreaterThan(0);
    expect(
      report.results.some((r) => r.id === "pkg:skill-md-parses" && r.severity === "error"),
    ).toBe(true);
  });

  it("detects broken file references", () => {
    const report = checkPackage(fixture("broken-refs"));
    // config.yaml exists, nonexistent-file.json does not, ./templates/main.txt does not
    const refResults = report.results.filter((r) => r.id.startsWith("ref:"));
    expect(refResults.length).toBeGreaterThan(0);

    const passRefs = refResults.filter((r) => r.severity === "pass");
    const errorRefs = refResults.filter((r) => r.severity === "error");
    expect(passRefs.length).toBeGreaterThanOrEqual(1); // config.yaml
    expect(errorRefs.length).toBeGreaterThanOrEqual(1); // nonexistent-file.json
  });

  it("warns on thin package body", () => {
    const report = checkPackage(fixture("thin-package"));
    expect(
      report.results.some(
        (r) => r.id === "heuristic:body-underspecified" && r.severity === "warning",
      ),
    ).toBe(true);
  });

  it("warns on short description", () => {
    const report = checkPackage(fixture("thin-package"));
    expect(
      report.results.some(
        (r) => r.id === "heuristic:description-length" && r.severity === "warning",
      ),
    ).toBe(true);
  });

  it("warns on bloated package body", () => {
    const report = checkPackage(fixture("bloated-package"));
    expect(
      report.results.some((r) => r.id === "heuristic:body-oversized" && r.severity === "warning"),
    ).toBe(true);
  });

  it("returns structured report with timestamp and summary", () => {
    const report = checkPackage(fixture("valid-skill"));
    expect(report.timestamp).toBeTruthy();
    expect(report.summary.total).toBe(report.results.length);
    expect(report.summary.passed + report.summary.warnings + report.summary.errors).toBe(
      report.summary.total,
    );
  });
});

describe("formatReport", () => {
  it("formats a passing report", () => {
    const report = checkPackage(fixture("valid-skill"));
    const output = formatReport(report);
    expect(output).toContain("commit-message-writer");
    expect(output).toContain("All checks passed");
  });

  it("formats a failing report with errors", () => {
    const report = checkPackage(fixture("missing-skill"));
    const output = formatReport(report);
    expect(output).toContain("[ERROR]");
    expect(output).toContain("SKILL.md not found");
  });

  it("formats a warning report", () => {
    const report = checkPackage(fixture("thin-package"));
    const output = formatReport(report);
    expect(output).toContain("[WARN]");
  });
});
