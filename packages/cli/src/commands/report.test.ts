import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import {
  evaluateWithGrader,
  GraderDefinitionSchema,
  type DeterministicGraderDefinition,
  type RunnerResult,
} from "@j-rig/core";
import {
  createDatabase,
  createGrade,
  createRawRun,
  sealRawRun,
  startRawRun,
  type JRigDatabase,
} from "@j-rig/db";
import { runSamplingReport } from "./report.js";

const tempDirs: string[] = [];

const cell = {
  task_id: "report-task",
  task_version: "1",
  config_id: "report-config",
  config_version: "1",
  model: "fixture-model",
};

const grader = GraderDefinitionSchema.parse({
  id: "report-checker",
  version: "1.0.0",
  kind: "deterministic",
  checks: [{ id: "has-answer", type: "output_contains", expected: "4" }],
}) as DeterministicGraderDefinition;

function completed(): RunnerResult {
  return {
    status: "completed",
    stdout: "4",
    stderr: "",
    exit_code: 0,
    signal: null,
    started_at: "2026-08-01T00:00:00.000Z",
    completed_at: "2026-08-01T00:00:00.001Z",
    duration_ms: 1,
    artifacts: [],
  };
}

function addRun(database: JRigDatabase, sampleIndex: number): string {
  const run = createRawRun(database, {
    ...cell,
    sample_index: sampleIndex,
    task: { id: cell.task_id },
    config: { id: cell.config_id },
    request: {},
  });
  startRawRun(database, run.id);
  sealRawRun(database, run.id, completed());
  return run.id;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("generic sampling report", () => {
  it("reports exact selected snapshot counts and uncertainty fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "j-rig-report-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "sampling.yaml");
    const dbPath = join(dir, "report.db");
    const fileDatabase = createDatabase(dbPath);
    const fileFirst = addRun(fileDatabase, 0);
    const fileSecond = addRun(fileDatabase, 1);
    const fileFirstGrade = createGrade(fileDatabase, evaluateWithGrader(fileFirst, "4", grader));
    createGrade(fileDatabase, evaluateWithGrader(fileSecond, "missing", grader));
    fileDatabase.close();
    writeFileSync(manifestPath, stringify({ cells: [cell] }));

    const report = runSamplingReport({
      manifestPath,
      db: dbPath,
      selector: {
        grader_id: grader.id,
        grader_version: grader.version,
        grader_snapshot_sha256: fileFirstGrade.grade.grader_snapshot_sha256,
      },
    });

    expect(report.observations).toHaveLength(2);
    expect(report.measurements[0]).toMatchObject({
      completed_runs: 2,
      graded_runs: 2,
      pass_count: 1,
      fail_count: 1,
      pass_rate: 0.5,
      judge_sampled_runs: 0,
      judge_vote_count: 0,
      judge_disagreement_rate: null,
    });
  });
});
