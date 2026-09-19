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
import { runSamplingReport, runUnifiedReport } from "./report.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("unified report command", () => {
  it("renders selected Grade lineage as JSON and Markdown", () => {
    const dir = mkdtempSync(join(tmpdir(), "j-rig-report-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "runs.db");
    const database = createDatabase(dbPath);
    const run = createRawRun(database, {
      task_id: "task-a",
      task_version: "1",
      config_id: "config-a",
      config_version: "1",
      model: "model-a",
      sample_index: 0,
      task: { id: "task-a" },
      config: { id: "config-a" },
      request: {},
    });
    startRawRun(database, run.id);
    sealRawRun(database, run.id, {
      status: "completed",
      stdout: "4",
      stderr: "",
      exit_code: 0,
      signal: null,
      started_at: "2026-08-01T00:00:00.000Z",
      completed_at: "2026-08-01T00:00:00.001Z",
      duration_ms: 1,
      artifacts: [],
    });
    const grader = GraderDefinitionSchema.parse({
      id: "answer-checker",
      version: "1.0.0",
      kind: "deterministic",
      checks: [{ id: "has-answer", type: "output_contains", expected: "4" }],
    }) as DeterministicGraderDefinition;
    const evaluation = evaluateWithGrader(run.id, "4", grader);
    createGrade(database, evaluation);
    database.close();

    const json = runUnifiedReport({
      db: dbPath,
      graderId: grader.id,
      graderVersion: grader.version,
      graderSnapshotSha256: evaluation.grader_snapshot_sha256,
      json: true,
    });
    expect(JSON.parse(json.rendered).schema).toBe("j-rig/unified-report/v1");
    expect(json.report.summary.graded_runs).toBe(1);

    const markdown = runUnifiedReport({
      db: dbPath,
      graderId: grader.id,
      graderVersion: grader.version,
      graderSnapshotSha256: evaluation.grader_snapshot_sha256,
    });
    expect(markdown.rendered).toContain("# J-Rig Unified Evaluation Report");
    expect(markdown.rendered).toContain("answer-checker@1.0.0");
  });
});

const samplingCell = {
  task_id: "report-task",
  task_version: "1",
  config_id: "report-config",
  config_version: "1",
  model: "fixture-model",
};

const samplingGrader = GraderDefinitionSchema.parse({
  id: "report-checker",
  version: "1.0.0",
  kind: "deterministic",
  checks: [{ id: "has-answer", type: "output_contains", expected: "4" }],
}) as DeterministicGraderDefinition;

function completedRun(): RunnerResult {
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

function addSamplingRun(database: JRigDatabase, sampleIndex: number): string {
  const run = createRawRun(database, {
    ...samplingCell,
    sample_index: sampleIndex,
    task: { id: samplingCell.task_id },
    config: { id: samplingCell.config_id },
    request: {},
  });
  startRawRun(database, run.id);
  sealRawRun(database, run.id, completedRun());
  return run.id;
}

describe("sampling report command", () => {
  it("reports exact selected snapshot counts and uncertainty fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "j-rig-report-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "sampling.yaml");
    const dbPath = join(dir, "report.db");
    const fileDatabase = createDatabase(dbPath);
    const fileFirst = addSamplingRun(fileDatabase, 0);
    const fileSecond = addSamplingRun(fileDatabase, 1);
    const fileFirstGrade = createGrade(
      fileDatabase,
      evaluateWithGrader(fileFirst, "4", samplingGrader),
    );
    createGrade(fileDatabase, evaluateWithGrader(fileSecond, "missing", samplingGrader));
    fileDatabase.close();
    writeFileSync(manifestPath, stringify({ cells: [samplingCell] }));

    const report = runSamplingReport({
      manifestPath,
      db: dbPath,
      selector: {
        grader_id: samplingGrader.id,
        grader_version: samplingGrader.version,
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
