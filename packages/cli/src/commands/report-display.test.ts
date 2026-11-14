import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  createDatabase,
  createRun,
  getOrCreateSkillVersion,
  recordArtifact,
  storeCriterionResults,
  storeRunSummary,
  transitionRun,
} from "@j-rig/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerReportCommand } from "./report.js";

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "report-display-"));
  dbPath = join(directory, "runs.db");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function seed(skill = "demo", complete = true): number {
  const db = createDatabase(dbPath);
  try {
    const version = getOrCreateSkillVersion(db, skill, "1", `skill text for ${skill}`);
    const id = createRun(db, version);
    if (!complete) return id;
    transitionRun(db, id, "running");
    transitionRun(db, id, "completed");
    storeCriterionResults(db, id, [
      { criterion_id: "ok", passed: true, severity: "pass", message: "Present" },
      { criterion_id: "warn", passed: false, severity: "warning", message: "Review needed" },
    ]);
    storeRunSummary(db, id, { total: 2, passed: 1, warnings: 1, errors: 0 });
    recordArtifact(db, id, "report", "results.json", "results.json");
    return id;
  } finally {
    db.close();
  }
}

async function invoke(extra: string[] = []): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerReportCommand(program);
  await program.parseAsync(["node", "j-rig", "report", "--db", dbPath, ...extra]);
}

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((args) => String(args[0]))
    .join("\n");
}

describe("legacy report rendering", () => {
  it("prints detail status, score, criteria and artifact metadata", async () => {
    const id = seed();
    await invoke(["--run-id", String(id)]);
    expect(output()).toContain(`Run #${id}`);
    expect(output()).toContain("Status: completed | Model: n/a | Type: deterministic");
    expect(output()).toContain("Duration:");
    expect(output()).toContain("Score: 1/2 (50%)");
    expect(output()).toContain("ok: Present");
    expect(output()).toContain("warn: Review needed");
    expect(output()).toContain("results.json (report)");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("omits absent duration, summary and artifacts for a pending run", async () => {
    const id = seed("pending", false);
    await invoke(["--run-id", String(id)]);
    expect(output()).toContain("Status: pending");
    expect(output()).toContain("Criterion Results:");
    expect(output()).not.toMatch(/Duration:|Score:|Artifacts:/);
  });

  it("preserves the structured detail response", async () => {
    const id = seed();
    await invoke(["--run-id", String(id), "--json"]);
    expect(JSON.parse(output())).toMatchObject({
      run: { id, status: "completed", summary: { passed: 1, total: 2 } },
      results: [{ criterion_id: "ok" }, { criterion_id: "warn" }],
      artifacts: [{ filename: "results.json", artifact_type: "report" }],
    });
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it("keeps the skill filter and latest-run limit in list mode", async () => {
    seed("older-skill");
    const id = seed("selected-skill");
    await invoke(["--skill", "selected-skill", "--limit", "1"]);
    expect(output()).toContain("Recent Runs:");
    expect(output()).toContain("selected-skill");
    expect(output()).not.toContain("older-skill");
    vi.mocked(console.log).mockClear();
    await invoke(["--limit", "1", "--json"]);
    expect(JSON.parse(output())).toMatchObject([
      { runs: { id }, skill_versions: { skill_name: "selected-skill" } },
    ]);
    expect(JSON.parse(output())).toHaveLength(1);
  });

  it("reports an empty list explicitly", async () => {
    await invoke();
    expect(output()).toContain("No runs found.");
    expect(console.error).not.toHaveBeenCalled();
  });
});

const graderOptions = [
  "--unified",
  "--grader-id",
  "grader",
  "--grader-version",
  "1",
  "--grader-snapshot-sha256",
  `sha256:${"a".repeat(64)}`,
];

describe("unified report command dispatch", () => {
  it("writes JSON to stdout when no output file is selected", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await invoke([...graderOptions, "--json"]);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stdout.mock.calls[0][0])).schema).toBe("j-rig/unified-report/v1");
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("writes HTML to the selected file without duplicating it on stdout", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const file = join(directory, "report.html");
    await invoke([...graderOptions, "--html", "--output", file]);
    expect(readFileSync(file, "utf8")).toContain("<!doctype html>");
    expect(stdout).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    { args: ["--html"], message: "--html requires --unified" },
    { args: ["--serve"], message: "--serve requires --unified" },
    { args: ["--unified", "--serve"], message: "--serve requires --html" },
    {
      args: ["--unified"],
      message: "--unified requires --grader-id, --grader-version, and --grader-snapshot-sha256",
    },
    {
      args: [...graderOptions, "--html", "--json"],
      message: "--html and --json are mutually exclusive",
    },
  ])("preserves option refusal: $message", async ({ args, message }) => {
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit intercepted");
    });
    await expect(invoke(args)).rejects.toThrow("exit intercepted");
    expect(console.error).toHaveBeenCalledWith(`Error: ${message}`);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.log).not.toHaveBeenCalled();
  });
});
