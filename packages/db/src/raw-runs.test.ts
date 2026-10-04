import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawRun,
  deriveRawRunId,
  getRawRun,
  getRawRunArtifacts,
  getRawRunByLineage,
  isRawRunSealed,
  sealRawRun,
  startRawRun,
  type JRigDatabase,
} from "./index.js";
import type { RunnerResult } from "@j-rig/core";

const lineage = {
  task_id: "echo-task",
  task_version: "1",
  config_id: "local-echo",
  config_version: "1",
  model: "fixture-model",
  sample_index: 0,
};

const input = {
  ...lineage,
  task: { id: "echo-task", version: "1", input: { message: "hello" } },
  config: { id: "local-echo", version: "1", model: "fixture-model" },
  request: { run_id: "derived", task: "echo-task" },
};

const result = (status: RunnerResult["status"]): RunnerResult => ({
  status,
  stdout: status === "completed" ? "hello" : "partial output",
  stderr: status === "completed" ? "" : "harness failed",
  exit_code: status === "completed" ? 0 : 7,
  signal: null,
  started_at: "2026-08-01T00:00:00.000Z",
  completed_at: "2026-08-01T00:00:00.025Z",
  duration_ms: 25,
  error_message: status === "completed" ? undefined : "fixture failure",
  artifacts:
    status === "completed"
      ? [
          {
            name: "result.json",
            relative_path: "artifacts/result.json",
            media_type: "application/json",
            size_bytes: 17,
            sha256: `sha256:${"a".repeat(64)}`,
          },
        ]
      : [],
});

describe("raw run ledger", () => {
  let database: JRigDatabase;

  beforeEach(() => {
    database = createDatabase(":memory:");
  });

  afterEach(() => {
    database.close();
  });

  it("derives an idempotent identity from task/config/model/sample lineage", () => {
    const first = deriveRawRunId(lineage);
    const second = deriveRawRunId(lineage);
    const nextSample = deriveRawRunId({ ...lineage, sample_index: 1 });

    expect(first).toBe(second);
    expect(first).not.toBe(nextSample);
    expect(first).toMatch(/^raw_[a-f0-9]{64}$/);
  });

  it("persists lineage before execution and resumes without duplicating the row", () => {
    const first = createRawRun(database, input);
    const resumed = createRawRun(database, input);

    expect(first.id).toBe(resumed.id);
    expect(first.status).toBe("pending");
    expect(getRawRunByLineage(database, lineage)?.id).toBe(first.id);
  });

  it("seals successful output and an immutable artifact manifest", () => {
    const created = createRawRun(database, input);
    startRawRun(database, created.id);
    const sealed = sealRawRun(database, created.id, result("completed"));

    expect(sealed.status).toBe("completed");
    expect(sealed.stdout).toBe("hello");
    expect(sealed.sealed_at).toBeTruthy();
    expect(getRawRunArtifacts(database, created.id)).toMatchObject([
      {
        name: "result.json",
        sha256: `sha256:${"a".repeat(64)}`,
      },
    ]);
    expect(isRawRunSealed(sealed.status)).toBe(true);
    expect(() => sealRawRun(database, created.id, result("completed"))).toThrow("not running");
  });

  it("retains runner failures and timeouts as distinct terminal outcomes", () => {
    const failed = createRawRun(database, { ...input, sample_index: 1 });
    startRawRun(database, failed.id);
    expect(sealRawRun(database, failed.id, result("runner_error")).status).toBe("runner_error");

    const timedOut = createRawRun(database, { ...input, sample_index: 2 });
    startRawRun(database, timedOut.id);
    expect(sealRawRun(database, timedOut.id, result("timed_out")).status).toBe("timed_out");
  });

  it("rejects an artifact that is not content-addressed", () => {
    const created = createRawRun(database, input);
    startRawRun(database, created.id);
    const invalid = result("completed");
    invalid.artifacts[0]!.sha256 = "not-a-digest";

    expect(() => sealRawRun(database, created.id, invalid)).toThrow("sha256:<64 lowercase hex");
    expect(getRawRun(database, created.id)?.status).toBe("running");
  });
});

describe("raw run ledger — fail-closed identity and lifecycle guards", () => {
  let database: JRigDatabase;

  beforeEach(() => {
    database = createDatabase(":memory:");
  });

  afterEach(() => {
    database.close();
  });

  it("refuses a snapshot that cannot be serialized to JSON before writing anything", () => {
    expect(() => createRawRun(database, { ...input, task: undefined })).toThrow(
      "task snapshot must be JSON serializable",
    );
    expect(() => createRawRun(database, { ...input, config: () => "fn" })).toThrow(
      "config snapshot must be JSON serializable",
    );
    expect(() => createRawRun(database, { ...input, request: Symbol("x") })).toThrow(
      "request snapshot must be JSON serializable",
    );
    expect(getRawRunByLineage(database, lineage)).toBeNull();
  });

  it("refuses to reuse an id whose lineage or any snapshot differs", () => {
    const created = createRawRun(database, input);
    const variants: Array<Partial<typeof input>> = [
      { task_id: "other-task" },
      { task_version: "2" },
      { config_id: "other-config" },
      { config_version: "2" },
      { model: "other-model" },
      { sample_index: 9 },
      { task: { ...input.task, input: { message: "changed" } } },
      { config: { ...input.config, model: "changed" } },
      { request: { run_id: "derived", task: "changed" } },
    ];
    for (const variant of variants) {
      expect(() => createRawRun(database, { ...input, ...variant, run_id: created.id })).toThrow(
        `Raw Run ${created.id} already exists with different lineage or snapshots`,
      );
    }
    expect(getRawRun(database, created.id)).toEqual(created);
  });

  it("honors an explicit run id and returns null for unknown ids", () => {
    const created = createRawRun(database, { ...input, run_id: "raw_explicit" });
    expect(created.id).toBe("raw_explicit");
    expect(getRawRun(database, "raw_missing")).toBeNull();
  });

  it("starts idempotently and refuses to restart a sealed or unknown run", () => {
    const created = createRawRun(database, input);
    const started = startRawRun(database, created.id);
    expect(started.status).toBe("running");
    expect(startRawRun(database, created.id)).toEqual(started);

    sealRawRun(database, created.id, result("runner_error"));
    expect(() => startRawRun(database, created.id)).toThrow(
      `Raw Run ${created.id} is already sealed`,
    );
    expect(() => startRawRun(database, "raw_missing")).toThrow("Raw Run raw_missing not found");
  });

  it("refuses to seal an unknown or still-pending run", () => {
    expect(() => sealRawRun(database, "raw_missing", result("completed"))).toThrow(
      "Raw Run raw_missing not found",
    );
    const pending = createRawRun(database, input);
    expect(() => sealRawRun(database, pending.id, result("completed"))).toThrow("not running");
    expect(getRawRun(database, pending.id)?.status).toBe("pending");
  });

  it("stores a null media type and a null error message when the runner omits them", () => {
    const created = createRawRun(database, input);
    startRawRun(database, created.id);
    const completed = result("completed");
    delete completed.artifacts[0]!.media_type;
    const sealed = sealRawRun(database, created.id, completed);
    expect(sealed.error_message).toBeNull();
    expect(getRawRunArtifacts(database, created.id)[0]!.media_type).toBeNull();
  });

  it("classifies only completed, runner_error, and timed_out as sealed", () => {
    expect(isRawRunSealed("completed")).toBe(true);
    expect(isRawRunSealed("runner_error")).toBe(true);
    expect(isRawRunSealed("timed_out")).toBe(true);
    expect(isRawRunSealed("pending")).toBe(false);
    expect(isRawRunSealed("running")).toBe(false);
  });
});
