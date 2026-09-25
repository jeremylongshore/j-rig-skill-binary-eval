import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { RunnerResult } from "@j-rig/core";
import type { JRigDatabase } from "./database.js";
import { rawRunArtifacts, rawRuns, type RawRunStatus } from "./schema.js";

export interface RawRunLineage {
  task_id: string;
  task_version: string;
  config_id: string;
  config_version: string;
  model: string;
  sample_index: number;
}

export interface CreateRawRunInput extends RawRunLineage {
  task: unknown;
  config: unknown;
  request: unknown;
  run_id?: string;
}

function snapshot(value: unknown, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${label} snapshot must be JSON serializable`);
  return serialized;
}

/** Derive an idempotent identity for one task/config/model/sample execution. */
export function deriveRawRunId(lineage: RawRunLineage): string {
  const key = JSON.stringify([
    lineage.task_id,
    lineage.task_version,
    lineage.config_id,
    lineage.config_version,
    lineage.model,
    lineage.sample_index,
  ]);
  return `raw_${createHash("sha256").update(key).digest("hex")}`;
}

export function getRawRun(database: JRigDatabase, runId: string) {
  return database.db.select().from(rawRuns).where(eq(rawRuns.id, runId)).get() ?? null;
}

export function getRawRunByLineage(database: JRigDatabase, lineage: RawRunLineage) {
  return (
    database.db
      .select()
      .from(rawRuns)
      .where(
        and(
          eq(rawRuns.task_id, lineage.task_id),
          eq(rawRuns.task_version, lineage.task_version),
          eq(rawRuns.config_id, lineage.config_id),
          eq(rawRuns.config_version, lineage.config_version),
          eq(rawRuns.model, lineage.model),
          eq(rawRuns.sample_index, lineage.sample_index),
        ),
      )
      .get() ?? null
  );
}

/**
 * Insert the durable lineage row before any harness process starts.
 * Repeated calls for the same lineage return the existing row and never create
 * a second identity, which makes a resumed sample safe by construction.
 */
export function createRawRun(database: JRigDatabase, input: CreateRawRunInput) {
  const runId = input.run_id ?? deriveRawRunId(input);
  const taskJson = snapshot(input.task, "task");
  const configJson = snapshot(input.config, "config");
  const requestJson = snapshot(input.request, "request");
  const existing = getRawRun(database, runId);
  if (existing) {
    const sameLineage =
      existing.task_id === input.task_id &&
      existing.task_version === input.task_version &&
      existing.config_id === input.config_id &&
      existing.config_version === input.config_version &&
      existing.model === input.model &&
      existing.sample_index === input.sample_index;
    if (
      !sameLineage ||
      existing.task_json !== taskJson ||
      existing.config_json !== configJson ||
      existing.request_json !== requestJson
    ) {
      throw new Error(`Raw Run ${runId} already exists with different lineage or snapshots`);
    }
    return existing;
  }

  database.db
    .insert(rawRuns)
    .values({
      id: runId,
      task_id: input.task_id,
      task_version: input.task_version,
      config_id: input.config_id,
      config_version: input.config_version,
      model: input.model,
      sample_index: input.sample_index,
      status: "pending",
      task_json: taskJson,
      config_json: configJson,
      request_json: requestJson,
    })
    .onConflictDoNothing()
    .run();

  const created = getRawRun(database, runId) ?? getRawRunByLineage(database, input);
  if (!created) throw new Error(`Unable to create raw run ${runId}`);
  return created;
}

/** Start a pending row; repeated starts are idempotent for a resumed worker. */
export function startRawRun(database: JRigDatabase, runId: string) {
  const run = getRawRun(database, runId);
  if (!run) throw new Error(`Raw Run ${runId} not found`);
  if (run.status === "running") return run;
  if (run.status !== "pending") throw new Error(`Raw Run ${runId} is already sealed`);

  database.db
    .update(rawRuns)
    .set({ status: "running", started_at: new Date().toISOString() })
    .where(and(eq(rawRuns.id, runId), eq(rawRuns.status, "pending")))
    .run();

  const started = getRawRun(database, runId);
  if (!started) throw new Error(`Unable to start raw run ${runId}`);
  return started;
}

function assertArtifactDigest(sha256: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Raw Run artifact digest must be sha256:<64 lowercase hex chars>: ${sha256}`);
  }
}

/**
 * Seal a running row exactly once with the ungraded runner observation.
 * Terminal rows cannot be overwritten, which keeps later Graders from
 * changing the source bytes or harness outcome.
 */
export function sealRawRun(database: JRigDatabase, runId: string, result: RunnerResult) {
  const run = getRawRun(database, runId);
  if (!run) throw new Error(`Raw Run ${runId} not found`);
  if (run.status !== "running") throw new Error(`Raw Run ${runId} is not running`);

  for (const artifact of result.artifacts) assertArtifactDigest(artifact.sha256);

  database.db.transaction((tx) => {
    const update = tx
      .update(rawRuns)
      .set({
        status: result.status as RawRunStatus,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
        signal: result.signal,
        started_at: result.started_at,
        completed_at: result.completed_at,
        duration_ms: result.duration_ms,
        error_message: result.error_message ?? null,
        sealed_at: new Date().toISOString(),
      })
      .where(and(eq(rawRuns.id, runId), eq(rawRuns.status, "running")))
      .run();

    if (update.changes !== 1) throw new Error(`Raw Run ${runId} was sealed concurrently`);

    for (const artifact of result.artifacts) {
      tx.insert(rawRunArtifacts)
        .values({
          run_id: runId,
          name: artifact.name,
          relative_path: artifact.relative_path,
          media_type: artifact.media_type ?? null,
          size_bytes: artifact.size_bytes,
          sha256: artifact.sha256,
        })
        .run();
    }
  });

  const sealed = getRawRun(database, runId);
  if (!sealed) throw new Error(`Unable to read sealed raw run ${runId}`);
  return sealed;
}

export function getRawRunArtifacts(database: JRigDatabase, runId: string) {
  return database.db
    .select()
    .from(rawRunArtifacts)
    .where(eq(rawRunArtifacts.run_id, runId))
    .orderBy(rawRunArtifacts.id)
    .all();
}

export function getRecentRawRuns(database: JRigDatabase, limit = 20) {
  return database.db.select().from(rawRuns).orderBy(desc(rawRuns.created_at)).limit(limit).all();
}

export function isRawRunSealed(status: RawRunStatus): boolean {
  return status === "completed" || status === "runner_error" || status === "timed_out";
}
