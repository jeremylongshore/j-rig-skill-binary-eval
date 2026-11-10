import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  createDatabase,
  createRun,
  getOrCreateSkillVersion,
  storeCriterionResults,
  transitionRun,
} from "@j-rig/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOptimizeCommand } from "./optimize.js";

let directory: string;
let dbPath: string;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "optimize-report-"));
  dbPath = join(directory, "runs.db");
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function seed(passed: boolean, results = true): number {
  const db = createDatabase(dbPath);
  try {
    const version = getOrCreateSkillVersion(db, "demo", "1", "skill text");
    const id = createRun(db, version);
    transitionRun(db, id, "running");
    transitionRun(db, id, "completed");
    if (results)
      storeCriterionResults(db, id, [
        {
          criterion_id: "criterion-one",
          passed,
          severity: "error",
          message: "Recorded outcome",
          method: "judge",
        },
      ]);
    return id;
  } finally {
    db.close();
  }
}

async function invoke(extra: string[] = []): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerOptimizeCommand(program);
  await program.parseAsync([
    "node",
    "j-rig",
    "optimize",
    "--skill",
    "demo",
    "--db",
    dbPath,
    ...extra,
  ]);
}

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((args) => String(args[0]))
    .join("\n");
}

describe("optimizer analysis output", () => {
  it("reports a passing latest run without an improvement target", async () => {
    const runId = seed(true);
    await invoke();
    expect(output()).toContain(`Optimization Analysis: demo (Run #${runId})`);
    expect(output()).toContain("No failures to cluster. All criteria passed.");
    expect(output()).toContain("No single weakest criterion identified.");
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("prints failure clusters and the weakest criterion", async () => {
    seed(false);
    await invoke();
    expect(output()).toContain("Failure Clusters:");
    expect(output()).toContain("criterion-one");
    expect(output()).toContain("Weakest Criterion:");
    expect(output()).toContain("Focus improvement efforts here first.");
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps JSON analysis free of absent optimizer metadata", async () => {
    const runId = seed(true);
    await invoke(["--json"]);
    expect(JSON.parse(output())).toEqual({ runId, clusters: [], weakest: null });
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it.each([
    { args: ["--run-id", "0"], message: "run-id must be a positive safe integer" },
    {
      args: ["--target-item", "only-one-bridge-field"],
      message: "Refiner experiments require --refiner-proposal",
    },
    { args: [], message: "No runs found for skill: demo" },
    { args: ["--run-id", "999"], message: "No results found for run #999" },
  ])("refuses invalid or missing analysis inputs: $message", async ({ args, message }) => {
    await invoke(args);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("refuses a latest run with no criterion results", async () => {
    const runId = seed(true, false);
    await invoke();
    expect(console.error).toHaveBeenCalledWith(`Error: No results found for run #${runId}`);
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
