import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importScriptedEvals,
  ScriptedInputSchema,
  type RunnerRequest,
  type ScriptedImport,
} from "@j-rig/core";
import { createRawRun, startRawRun, sealRawRun, deriveRawRunId } from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { runGrade } from "./grade.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "scripted-grade-"));
  roots.push(dir);
  const source = {
    skill_name: "whiteglove-pdf",
    evals: [
      {
        id: 1,
        scenario: "happy",
        prompt: "retained",
        expected_output: "prose",
        files: [],
        expectations: [],
        assertions: [{ cmd: "inert-authored-command", expect_exit: 2 }],
      },
    ],
  };
  const imported = importScriptedEvals(Buffer.from(JSON.stringify(source)), {
    python: "/trusted/python",
    runner: "/trusted/run_evals.py",
    cwd: "/trusted",
    runnerSha256: "a".repeat(64),
    fixtures: [],
    timeoutMs: 1000,
  });
  const scriptedImportPath = join(dir, "import.json");
  writeFileSync(scriptedImportPath, JSON.stringify(imported));
  return { imported, db: join(dir, "runs.db"), scriptedImportPath };
}
function requestFor(imported: ScriptedImport, sample: number): RunnerRequest {
  const lineage = {
    task_id: imported.task.id,
    task_version: imported.task.version,
    config_id: imported.config.id,
    config_version: imported.config.version,
    model: imported.config.model,
    sample_index: sample,
  };
  return {
    run_id: deriveRawRunId(lineage),
    task: imported.task,
    config: imported.config,
    model: imported.config.model,
    sample_index: sample,
  };
}
function receiptFor(request: RunnerRequest) {
  const input = ScriptedInputSchema.parse(request.task.input);
  return {
    format: "whiteglove-scripted-results/v1",
    complete: true,
    run_id: request.run_id,
    task_id: request.task.id,
    task_version: request.task.version,
    config_id: request.config.id,
    config_version: request.config.version,
    sample_index: request.sample_index,
    source_sha256: input.source_sha256,
    runner_sha256: input.runner_sha256,
    fixtures: [],
    cases: [
      {
        id: 1,
        assertions: [
          {
            index: 0,
            cmd: "inert-authored-command",
            expect_exit: 2,
            exit_code: 2,
            stdout: "",
            duration_ms: 1,
            completed: true,
            passed: true,
          },
        ],
      },
    ],
  };
}
function seal(db: string, request: RunnerRequest, stdout: string, exitCode = 0) {
  const database = openDb(db);
  try {
    createRawRun(database, {
      run_id: request.run_id,
      task_id: request.task.id,
      task_version: request.task.version,
      config_id: request.config.id,
      config_version: request.config.version,
      model: request.model,
      sample_index: request.sample_index,
      task: request.task,
      config: request.config,
      request,
    });
    startRawRun(database, request.run_id);
    sealRawRun(database, request.run_id, {
      status: "completed",
      stdout,
      stderr: "",
      exit_code: exitCode,
      signal: null,
      started_at: "2026-11-12T00:00:00Z",
      completed_at: "2026-11-12T00:00:01Z",
      duration_ms: 1000,
      artifacts: [],
    });
  } finally {
    database.close();
  }
}
describe("scripted persisted Run grading", () => {
  it("binds each sample to its saved request and rejects another run's valid receipt", async () => {
    const f = fixture();
    const first = requestFor(f.imported, 0);
    const next = requestFor(f.imported, 1);
    const receipt = JSON.stringify(receiptFor(first));
    seal(f.db, first, receipt);
    seal(f.db, next, receipt);
    const pass = await runGrade({ ...f, runId: first.run_id, regrade: false });
    expect(pass.grade.verdict).toBe("pass");
    expect((await runGrade({ ...f, runId: first.run_id, regrade: false })).created).toBe(false);
    const fail = await runGrade({ ...f, runId: next.run_id, regrade: false });
    expect(fail.grade.verdict).toBe("fail");
    expect(fail.grade.grader_id).not.toBe(pass.grade.grader_id);
  });
  it("keeps completed outer exit 1 gradeable but never passing", async () => {
    const f = fixture();
    const request = requestFor(f.imported, 0);
    seal(f.db, request, JSON.stringify(receiptFor(request)), 1);
    expect((await runGrade({ ...f, runId: request.run_id, regrade: false })).grade.verdict).toBe(
      "fail",
    );
  });
});
