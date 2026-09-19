import { asc } from "drizzle-orm";
import type {
  GradeMetadata,
  GradeObservation,
  GradeSelector,
  SampleObservation,
  SamplingCell,
} from "@j-rig/core";
import type { JRigDatabase } from "./database.js";
import { getGradeByIdentity } from "./grades.js";
import { rawRuns } from "./schema.js";

function cellFromRun(run: typeof rawRuns.$inferSelect): SamplingCell {
  return {
    task_id: run.task_id,
    task_version: run.task_version,
    config_id: run.config_id,
    config_version: run.config_version,
    model: run.model,
  };
}

function parseGradeMetadata(value: string | null): GradeMetadata | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as GradeMetadata) : undefined;
  } catch {
    return undefined;
  }
}

/** Return every generic Run in stable lineage/sample order for a sampler. */
export function getRawRunSampleObservations(database: JRigDatabase): SampleObservation[] {
  return database.db
    .select()
    .from(rawRuns)
    .orderBy(
      asc(rawRuns.task_id),
      asc(rawRuns.task_version),
      asc(rawRuns.config_id),
      asc(rawRuns.config_version),
      asc(rawRuns.model),
      asc(rawRuns.sample_index),
    )
    .all()
    .map((run) => ({ ...cellFromRun(run), sample_index: run.sample_index, status: run.status }));
}

/**
 * Join raw Runs to one explicitly selected Grader snapshot. Rows without that
 * Grade remain present as ungraded, allowing reports to distinguish missing
 * quality evidence from a failed harness or a failed check.
 */
export function getGradeObservations(
  database: JRigDatabase,
  selector: GradeSelector,
): GradeObservation[] {
  const runs = database.db
    .select()
    .from(rawRuns)
    .orderBy(
      asc(rawRuns.task_id),
      asc(rawRuns.task_version),
      asc(rawRuns.config_id),
      asc(rawRuns.config_version),
      asc(rawRuns.model),
      asc(rawRuns.sample_index),
    )
    .all();
  return runs.map((run) => {
    const observation = {
      ...cellFromRun(run),
      raw_run_id: run.id,
      sample_index: run.sample_index,
      status: run.status,
    } as GradeObservation;
    const grade = getGradeByIdentity(database, {
      raw_run_id: run.id,
      grader_id: selector.grader_id,
      grader_version: selector.grader_version,
      grader_snapshot_sha256: selector.grader_snapshot_sha256,
    });
    return {
      ...observation,
      grade: grade
        ? {
            grader_id: grade.grader_id,
            grader_version: grade.grader_version,
            grader_snapshot_sha256: grade.grader_snapshot_sha256,
            verdict: grade.verdict,
            score: grade.score,
            metadata: parseGradeMetadata(grade.metadata_json),
          }
        : undefined,
    };
  });
}
