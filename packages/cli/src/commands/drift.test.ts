import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createDatabase, createRun, getOrCreateSkillVersion, type JRigDatabase } from "@j-rig/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as databaseModule from "../lib/db.js";
import { registerDriftCommand } from "./drift.js";

const NOW = new Date("2026-11-01T12:00:00.000Z");
let directory: string;
let dbPath: string;
let handles: JRigDatabase[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "drift-command-"));
  dbPath = join(directory, "runs.db");
  handles = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  // Keep real SQLite initialization/query behavior; retain handles for cleanup.
  const openDatabase = databaseModule.openDb;
  vi.spyOn(databaseModule, "openDb").mockImplementation((path) => {
    const database = openDatabase(path);
    handles.push(database);
    return database;
  });
});

afterEach(() => {
  for (const database of handles) database.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

function seed(days: number, skill = "demo"): { id: number; timestamp: string } {
  const database = createDatabase(dbPath);
  try {
    const version = getOrCreateSkillVersion(database, skill, "1", `Skill ${skill}`);
    const id = createRun(database, version);
    const timestamp = new Date(NOW.getTime() - days * 86_400_000).toISOString();
    database.sqlite.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(timestamp, id);
    return { id, timestamp };
  } finally {
    database.close();
  }
}

async function invoke(extra: string[] = [], path = dbPath): Promise<void> {
  const program = new Command().exitOverride();
  registerDriftCommand(program);
  await program.parseAsync(["drift", "--skill", "demo", "--db", path, ...extra], { from: "user" });
}

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((args) => String(args[0]))
    .join("\n");
}

describe("drift registered command", () => {
  it("reports absent history in JSON and exits successfully", async () => {
    await invoke(["--json"]);
    expect(JSON.parse(output())).toEqual({ skill: "demo", status: "no_data", stale: true });
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports absent history with an actionable text message", async () => {
    await invoke();
    expect(output()).toContain("Drift Check: demo");
    expect(output()).toContain("No evaluation history found.");
    expect(output()).toContain("Run: j-rig eval <skill-dir>");
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    [2, false],
    [30, false],
    [31, true],
  ])("classifies a %i-day-old run as stale=%s", async (days, stale) => {
    const run = seed(days);
    await invoke(["--json"]);
    expect(JSON.parse(output())).toEqual({
      skill: "demo",
      lastEval: run.timestamp,
      daysAgo: days,
      stale,
      maxAge: 30,
      status: "pending",
    });
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("uses the newest matching skill run and custom age threshold", async () => {
    seed(100);
    const latest = seed(8);
    seed(0, "another-skill");
    await invoke(["--json", "--max-age", "7"]);
    expect(JSON.parse(output())).toEqual({
      skill: "demo",
      lastEval: latest.timestamp,
      daysAgo: 8,
      stale: true,
      maxAge: 7,
      status: "pending",
    });
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    [2, "CURRENT"],
    [31, "STALE"],
  ])("renders %i-day-old history with %s status", async (days, status) => {
    const run = seed(days);
    await invoke();
    expect(output()).toContain(`Last Eval: ${run.timestamp.slice(0, 10)} (${days} days ago)`);
    expect(output()).toContain(status);
    expect(output()).toContain("threshold: 30 days");
    expect(output()).toContain(`Last Run: #${run.id} (pending)`);
    expect(output().includes("Recommendation: Re-run evaluation")).toBe(status === "STALE");
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports SQLite open failure without claiming a drift result", async () => {
    await invoke(["--json"], directory);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^Error: /));
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
