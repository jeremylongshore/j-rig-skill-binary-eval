import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { measureQuality } from "./workspace-quality.ts";

describe("workspace quality measurement", () => {
  let root: string;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jrig-quality-test-"));
    execFileSync("git", ["init", "--quiet", root]);
    mkdirSync(join(root, ".audit-harness/scripts"), { recursive: true });
    for (const script of ["bias-count.sh", "gherkin-lint.sh"]) {
      copyFileSync(
        join(import.meta.dirname, "../.audit-harness/scripts", script),
        join(root, ".audit-harness/scripts", script),
      );
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("scans package, root and script tests without production or ignored-file contamination", () => {
    for (const path of [
      "packages/a/src/unit.test.ts",
      "tests/unit.test.ts",
      "scripts/unit.test.ts",
    ]) {
      write(path, 'it("observable result", () => { expect(result).toEqual(2); });\n');
    }
    write("packages/a/src/production.ts", "toBeDefined()\n");
    write(".gitignore", "tests/ignored.test.ts\n");
    write("tests/ignored.test.ts", "toBeDefined()\n");
    const report = measureQuality(root, "bias");
    expect(report.result).toBe("ADVISORY");
    expect(report.metadata).toMatchObject({
      discovered_files: 3,
      scanned_files: 3,
      test_count: 3,
      bias_total: 0,
    });
    const firstHash = report.input_hash;
    write(
      "packages/a/src/unit.test.ts",
      'it("weak assertion", () => { expect(result).toBeDefined(); });\n',
    );
    const changed = measureQuality(root, "bias");
    expect(changed.metadata).toMatchObject({ bias_total: 1 });
    expect(changed.input_hash).not.toBe(firstHash);
  });

  it("refuses an empty test corpus and a missing provider", () => {
    expect(() => measureQuality(root, "bias")).toThrow("No tests discovered");
    write("tests/unit.test.ts", 'it("works", () => expect(value).toEqual(2));');
    rmSync(join(root, ".audit-harness/scripts/bias-count.sh"));
    expect(() => measureQuality(root, "bias")).toThrow();
  });

  it("refuses symlinked tests instead of following undeclared inputs", () => {
    write("source.ts", 'it("works", () => expect(value).toEqual(2));');
    mkdirSync(join(root, "tests"));
    symlinkSync(join(root, "source.ts"), join(root, "tests/unit.test.ts"));
    expect(() => measureQuality(root, "bias")).toThrow("Symlink");
  });

  it("reports absent features as N/A and executes present feature checks", () => {
    expect(measureQuality(root, "gherkin")).toMatchObject({
      result: "NOT_APPLICABLE",
      metadata: { discovered_files: 0 },
    });
    write(
      "features/result.feature",
      "Feature: result\n  Scenario: result\n    Given a value\n    When it changes\n    Then a result exists\n",
    );
    expect(measureQuality(root, "gherkin")).toMatchObject({
      result: "PASS",
      metadata: { scanned_files: 1 },
    });
    write("features/result.feature", "Feature: result\n  Scenario: invalid\n    And a value\n");
    expect(measureQuality(root, "gherkin")).toMatchObject({
      result: "FAIL",
      metadata: { errors: 1 },
    });
  });

  it("refuses a provider crash or malformed result instead of converting either to advisory", () => {
    write("tests/unit.test.ts", 'it("works", () => expect(value).toEqual(2));');
    write(".audit-harness/scripts/bias-count.sh", "exit 2\n");
    expect(() => measureQuality(root, "bias")).toThrow("Scanner execution incomplete");
    write(".audit-harness/scripts/bias-count.sh", "printf '{}'\n");
    expect(() => measureQuality(root, "bias")).toThrow("Invalid scanner report");
  });
});
