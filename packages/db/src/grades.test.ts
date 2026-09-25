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
  getGradeByIdentity,
  getGradesForRun,
  sealRawRun,
  startRawRun,
  type JRigDatabase,
} from "./index.js";

const graderV1 = GraderDefinitionSchema.parse({
  id: "answer-checker",
  version: "1.0.0",
  kind: "deterministic",
  checks: [{ id: "has-answer", type: "output_contains", expected: "4" }],
}) as DeterministicGraderDefinition;

const graderV2 = GraderDefinitionSchema.parse({
  ...graderV1,
  version: "2.0.0",
  checks: [
    { id: "has-answer", type: "output_contains", expected: "4" },
    { id: "has-explanation", type: "output_contains", expected: "because" },
  ],
}) as DeterministicGraderDefinition;

const completed = (status: RunnerResult["status"] = "completed"): RunnerResult => ({
  status,
  stdout: "The answer is 4 because arithmetic.",
  stderr: "",
  exit_code: status === "completed" ? 0 : 1,
  signal: null,
  started_at: "2026-08-01T00:00:00.000Z",
  completed_at: "2026-08-01T00:00:00.025Z",
  duration_ms: 25,
  error_message: status === "completed" ? undefined : "runner failed",
  artifacts: [],
});

describe("immutable Grades", () => {
  let database: JRigDatabase;
  let rawRunId: string;

  beforeEach(() => {
    database = createDatabase(":memory:");
    const rawRun = createRawRun(database, {
      task_id: "answer-task",
      task_version: "1",
      config_id: "fixture-config",
      config_version: "1",
      model: "fixture-model",
      sample_index: 0,
      task: { id: "answer-task", version: "1" },
      config: { id: "fixture-config", version: "1", model: "fixture-model" },
      request: { task: "answer-task" },
    });
    rawRunId = rawRun.id;
    startRawRun(database, rawRunId);
    sealRawRun(database, rawRunId, completed());
  });

  afterEach(() => {
    database.close();
  });

  it("stores one named Grade and makes repeat persistence idempotent", () => {
    const evaluation = evaluateWithGrader(rawRunId, completed().stdout, graderV1);
    const first = createGrade(database, evaluation);
    const repeat = createGrade(database, evaluation);

    expect(first.created).toBe(true);
    expect(repeat.created).toBe(false);
    expect(first.grade.id).toBe(repeat.grade.id);
    expect(first.grade.verdict).toBe("pass");
    expect(JSON.parse(first.grade.grader_snapshot_json).version).toBe("1.0.0");
    expect(
      getGradeByIdentity(database, {
        raw_run_id: rawRunId,
        grader_id: first.grade.grader_id,
        grader_version: first.grade.grader_version,
        grader_snapshot_sha256: first.grade.grader_snapshot_sha256,
      })?.id,
    ).toBe(first.grade.id);
  });

  it("regrades the same Run into a new immutable Grade snapshot", () => {
    const first = createGrade(database, evaluateWithGrader(rawRunId, completed().stdout, graderV1));
    const second = createGrade(
      database,
      evaluateWithGrader(rawRunId, completed().stdout, graderV2),
    );

    expect(first.grade.id).not.toBe(second.grade.id);
    expect(getGradesForRun(database, rawRunId)).toHaveLength(2);
    expect(first.grade.grader_version).toBe("1.0.0");
    expect(second.grade.grader_version).toBe("2.0.0");
  });

  it("refuses to grade a runner failure", () => {
    const failedRun = createRawRun(database, {
      task_id: "answer-task",
      task_version: "1",
      config_id: "fixture-config",
      config_version: "1",
      model: "fixture-model",
      sample_index: 1,
      task: { id: "answer-task", version: "1" },
      config: { id: "fixture-config", version: "1", model: "fixture-model" },
      request: { task: "answer-task" },
    });
    startRawRun(database, failedRun.id);
    sealRawRun(database, failedRun.id, completed("runner_error"));

    expect(() =>
      createGrade(database, evaluateWithGrader(failedRun.id, "partial", graderV1)),
    ).toThrow("only completed Runs can be graded");
  });

  it("persists model-judge vote metadata alongside the immutable Grade", async () => {
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
    const evaluation = await evaluateWithModelJudge(rawRunId, completed().stdout, definition, {
      async judge() {
        return {
          verdict: votes.shift() ?? "unsure",
          confidence: 0.5,
          reasoning: "fixture vote",
        };
      },
    });

    const stored = createGrade(database, evaluation);
    const metadata = JSON.parse(stored.grade.metadata_json ?? "{}");

    expect(stored.grade.grader_kind).toBe("model_judge");
    expect(metadata.judge).toMatchObject({
      raw_verdict: "yes",
      samples: 3,
      agreement: 2 / 3,
      sample_verdicts: ["yes", "no", "yes"],
      disagreement: true,
    });
  });
});
