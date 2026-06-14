import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerMigrateCommand, runMigrate } from "./migrate.js";

let logs: string[];
let errs: string[];
const created: string[] = [];

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation(((...a: unknown[]) => {
    logs.push(a.join(" "));
  }) as never);
  vi.spyOn(console, "error").mockImplementation(((...a: unknown[]) => {
    errs.push(a.join(" "));
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

const V1_BUNDLE = JSON.stringify(
  [
    {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "j-rig:ci:MM-1", digest: { sha256: "a".repeat(64) } }],
      predicateType: "https://evals.intentsolutions.io/gate-result/v1",
      predicate: {
        gate_id: "j-rig:ci:MM-1",
        result: "PASS",
        policy_hash: `sha256:${"c".repeat(64)}`,
        input_hash: `sha256:${"a".repeat(64)}`,
        timestamp: "2026-06-13T00:00:00.000Z",
        runner: "j-rig@2.0.0",
        commit_sha: "abc1234",
      },
    },
  ],
  null,
  2,
);

function scratchDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "j-rig-migrate-cli-"));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("migrate command — registration", () => {
  it("registers on the program", () => {
    const program = new Command();
    registerMigrateCommand(program);
    const cmd = program.commands.find((c) => c.name() === "migrate");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/v2\.0/);
  });
});

describe("runMigrate", () => {
  it("dry-runs by default: prints a diff, writes nothing (exit 0)", () => {
    const dir = scratchDir({ "bundle.json": V1_BUNDLE });
    const code = runMigrate(dir, {});
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("would migrate");
    expect(out).toContain("dry run");
    expect(readFileSync(join(dir, "bundle.json"), "utf-8")).toContain('"result": "PASS"');
  });

  it("writes in place with --write (exit 0)", () => {
    const dir = scratchDir({ "bundle.json": V1_BUNDLE });
    const code = runMigrate(dir, { write: true });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("migrated");
    const after = readFileSync(join(dir, "bundle.json"), "utf-8");
    expect(after).toContain('"gate_decision": "pass"');
    expect(after).not.toContain('"result": "PASS"');
  });

  it("emits a JSON report with --json (exit 0)", () => {
    const dir = scratchDir({ "bundle.json": V1_BUNDLE });
    const code = runMigrate(dir, { json: true });
    expect(code).toBe(0);
    const report = JSON.parse(logs.join("\n"));
    expect(report.changedCount).toBe(1);
    expect(report.wrote).toBe(false);
    expect(report.files[0].rows[0].outcome).toBe("migrated");
  });

  it("reports zero files for an empty directory (exit 0)", () => {
    const dir = scratchDir({});
    const code = runMigrate(dir, {});
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("No JSON fixtures found");
  });

  it("reports a parse error on the console and exits 1", () => {
    const dir = scratchDir({ "broken.json": "{ not json" });
    const code = runMigrate(dir, {});
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("parse error");
  });

  it("exits 1 via --json when a parse error occurs", () => {
    const dir = scratchDir({ "broken.json": "{ not json" });
    const code = runMigrate(dir, { json: true });
    expect(code).toBe(1);
    const report = JSON.parse(logs.join("\n"));
    expect(report.errorCount).toBe(1);
  });

  it("skips an already-v2 file without reporting a change", () => {
    const v2 = JSON.stringify([{ predicate: { gate_id: "g", gate_decision: "pass" } }], null, 2);
    const dir = scratchDir({ "v2.json": v2 });
    const code = runMigrate(dir, {});
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("0 file(s) would migrate");
  });
});
