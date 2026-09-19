import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { createDatabase, createRawRun, sealRawRun, startRawRun } from "@j-rig/db";
import { runSamplePlan } from "./sample-plan.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("j-rig sample-plan", () => {
  it("plans missing samples from the persisted raw-run ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "j-rig-sample-plan-"));
    tempDirs.push(dir);
    const manifest = join(dir, "manifest.yaml");
    const dbPath = join(dir, "runs.db");
    const cell = {
      task_id: "task-a",
      task_version: "1",
      config_id: "config-a",
      config_version: "1",
      model: "model-a",
    };
    writeFileSync(manifest, stringify({ cells: [cell] }));

    const database = createDatabase(dbPath);
    const run = createRawRun(database, {
      ...cell,
      sample_index: 0,
      task: { id: "task-a" },
      config: { id: "config-a" },
      request: {},
    });
    startRawRun(database, run.id);
    sealRawRun(database, run.id, {
      status: "completed",
      stdout: "answer",
      stderr: "",
      exit_code: 0,
      signal: null,
      started_at: "2026-08-01T00:00:00.000Z",
      completed_at: "2026-08-01T00:00:00.001Z",
      duration_ms: 1,
      artifacts: [],
    });
    database.close();

    const result = runSamplePlan({ manifestPath: manifest, targetN: 3, db: dbPath });
    expect(result.plan.cells[0]).toMatchObject({ completed_count: 1, planned_count: 2 });
    expect(result.plan.jobs.map((job) => job.sample_index)).toEqual([1, 2]);
  });
});
