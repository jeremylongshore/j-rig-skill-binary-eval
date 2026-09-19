import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateWithGrader,
  evaluateWithModelJudge,
  GraderDefinitionSchema,
  type DeterministicGraderDefinition,
  type ModelJudgeGraderDefinition,
  type RunnerResult,
} from "@j-rig/core";
import {
  createDatabase,
  createGrade,
  createRawRun,
  getGradeObservations,
  getRawRunSampleObservations,
  sealRawRun,
  startRawRun,
  type JRigDatabase,
} from "./index.js";

const grader = GraderDefinitionSchema.parse({
  id: "answer-checker",
  version: "1.0.0",
  kind: "deterministic",
  checks: [{ id: "has-answer", type: "output_contains", expected: "4" }],
}) as DeterministicGraderDefinition;

function result(status: RunnerResult["status"], stdout = "4"): RunnerResult {
  return {
    status,
    stdout,
    stderr: "",
    exit_code: status === "completed" ? 0 : 1,
    signal: null,
    started_at: "2026-08-01T00:00:00.000Z",
    completed_at: "2026-08-01T00:00:00.001Z",
    duration_ms: 1,
    artifacts: [],
  };
}

describe("sampling database joins", () => {
  let database: JRigDatabase;

  beforeEach(() => {
    database = createDatabase(":memory:");
  });

  afterEach(() => database.close());

  it("returns raw outcomes and the selected Grade snapshot without collapsing failures", () => {
    const completed = createRawRun(database, {
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
    startRawRun(database, completed.id);
    sealRawRun(database, completed.id, result("completed"));
    createGrade(database, evaluateWithGrader(completed.id, "4", grader));

    const failed = createRawRun(database, {
      task_id: "task-a",
      task_version: "1",
      config_id: "config-a",
      config_version: "1",
      model: "model-a",
      sample_index: 1,
      task: { id: "task-a" },
      config: { id: "config-a" },
      request: {},
    });
    startRawRun(database, failed.id);
    sealRawRun(database, failed.id, result("runner_error", "partial"));

    const raw = getRawRunSampleObservations(database);
    expect(raw.map((row) => row.status)).toEqual(["completed", "runner_error"]);

    const selected = getGradeObservations(database, {
      grader_id: grader.id,
      grader_version: grader.version,
      grader_snapshot_sha256: evaluateWithGrader(completed.id, "4", grader).grader_snapshot_sha256,
    });
    expect(selected).toHaveLength(2);
    expect(selected[0]?.grade?.verdict).toBe("pass");
    expect(selected[1]?.grade).toBeUndefined();
  });

  it("keeps external judge vote sampling visible in selected observations", async () => {
    const completed = createRawRun(database, {
      task_id: "task-judge",
      task_version: "1",
      config_id: "config-judge",
      config_version: "1",
      model: "model-judge",
      sample_index: 0,
      task: { id: "task-judge" },
      config: { id: "config-judge" },
      request: {},
    });
    startRawRun(database, completed.id);
    sealRawRun(database, completed.id, result("completed", "answer"));

    const definition = GraderDefinitionSchema.parse({
      id: "quality-judge",
      version: "1.0.0",
      kind: "model_judge",
      model: "fixture-judge",
      criterion_description: "The output is correct",
      judge_prompt: "Answer yes only when the output is correct.",
      samples: 3,
    }) as ModelJudgeGraderDefinition;
    const votes: Array<"yes" | "no" | "unsure"> = ["yes", "no", "yes"];
    const evaluation = await evaluateWithModelJudge(completed.id, "answer", definition, {
      async judge() {
        return {
          verdict: votes.shift() ?? "unsure",
          confidence: 0.5,
          reasoning: "fixture vote",
        };
      },
    });
    createGrade(database, evaluation);

    const selected = getGradeObservations(database, {
      grader_id: definition.id,
      grader_version: definition.version,
      grader_snapshot_sha256: evaluation.grader_snapshot_sha256,
    });

    expect(selected[0]?.grade?.metadata?.judge).toMatchObject({
      samples: 3,
      agreement: 2 / 3,
      disagreement: true,
      sample_verdicts: ["yes", "no", "yes"],
    });
  });
});
