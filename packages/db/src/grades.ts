import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { GradeEvaluation } from "@j-rig/core";
import type { JRigDatabase } from "./database.js";
import { getRawRun } from "./raw-runs.js";
import { grades, type StoredGradeVerdict } from "./schema.js";

function deriveGradeId(evaluation: GradeEvaluation): string {
  const key = [
    evaluation.raw_run_id,
    evaluation.grader_id,
    evaluation.grader_version,
    evaluation.grader_snapshot_sha256,
  ].join("\u0000");
  return `grade_${createHash("sha256").update(key).digest("hex")}`;
}

export function getGrade(database: JRigDatabase, gradeId: string) {
  return database.db.select().from(grades).where(eq(grades.id, gradeId)).get() ?? null;
}

export function getGradesForRun(database: JRigDatabase, rawRunId: string) {
  return database.db
    .select()
    .from(grades)
    .where(eq(grades.raw_run_id, rawRunId))
    .orderBy(desc(grades.created_at))
    .all();
}

export function getGradeByIdentity(
  database: JRigDatabase,
  identity: {
    raw_run_id: string;
    grader_id: string;
    grader_version: string;
    grader_snapshot_sha256: string;
  },
) {
  return (
    database.db
      .select()
      .from(grades)
      .where(
        and(
          eq(grades.raw_run_id, identity.raw_run_id),
          eq(grades.grader_id, identity.grader_id),
          eq(grades.grader_version, identity.grader_version),
          eq(grades.grader_snapshot_sha256, identity.grader_snapshot_sha256),
        ),
      )
      .get() ?? null
  );
}

/**
 * Persist a Grade over a sealed successful raw Run.
 *
 * Inserts are idempotent for the same grader snapshot. A different grader
 * version or snapshot gets a new Grade row and never updates the old one.
 */
export function createGrade(database: JRigDatabase, evaluation: GradeEvaluation) {
  const rawRun = getRawRun(database, evaluation.raw_run_id);
  if (!rawRun) throw new Error(`Raw Run ${evaluation.raw_run_id} not found`);
  if (rawRun.status !== "completed") {
    throw new Error(
      `Raw Run ${evaluation.raw_run_id} is ${rawRun.status}; only completed Runs can be graded`,
    );
  }

  const id = deriveGradeId(evaluation);
  const existing = getGrade(database, id);
  if (existing) return { grade: existing, created: false };

  database.db
    .insert(grades)
    .values({
      id,
      raw_run_id: evaluation.raw_run_id,
      grader_id: evaluation.grader_id,
      grader_version: evaluation.grader_version,
      grader_kind: evaluation.grader_kind,
      grader_snapshot_json: evaluation.grader_snapshot_json,
      grader_snapshot_sha256: evaluation.grader_snapshot_sha256,
      verdict: evaluation.verdict as StoredGradeVerdict,
      score: evaluation.score,
      checks_json: JSON.stringify(evaluation.checks),
      metadata_json: evaluation.metadata ? JSON.stringify(evaluation.metadata) : null,
    })
    .onConflictDoNothing()
    .run();

  const grade = getGrade(database, id);
  if (!grade) throw new Error(`Unable to create Grade ${id}`);
  return { grade, created: true };
}
