import { eq, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { JRigDatabase } from "./database.js";
import { skillVersions, runs, criterionResults, runSummaries, artifacts } from "./schema.js";
import type { RunStatus } from "./schema.js";
import { isValidTransition } from "./lifecycle.js";

/**
 * Get or create a skill version record.
 */
export function getOrCreateSkillVersion(
  { db }: JRigDatabase,
  skillName: string,
  version: string,
  skillMdContent: string,
): number {
  const hash = createHash("sha256").update(skillMdContent).digest("hex").slice(0, 16);

  const existing = db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skill_md_hash, hash))
    .get();

  if (existing) return existing.id;

  const result = db
    .insert(skillVersions)
    .values({ skill_name: skillName, version, skill_md_hash: hash })
    .returning({ id: skillVersions.id })
    .get();

  return result.id;
}

/**
 * Create a new evaluation run.
 */
export function createRun(
  { db }: JRigDatabase,
  skillVersionId: number,
  runType: string = "deterministic",
  model?: string,
): number {
  const result = db
    .insert(runs)
    .values({
      skill_version_id: skillVersionId,
      run_type: runType,
      model: model ?? null,
      status: "pending",
    })
    .returning({ id: runs.id })
    .get();

  return result.id;
}

/**
 * Transition a run to a new status.
 * Throws if the transition is invalid.
 */
export function transitionRun(
  { db }: JRigDatabase,
  runId: number,
  newStatus: RunStatus,
): void {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) throw new Error(`Run ${runId} not found`);

  const currentStatus = run.status as RunStatus;
  if (!isValidTransition(currentStatus, newStatus)) {
    throw new Error(
      `Invalid transition: ${currentStatus} → ${newStatus}`,
    );
  }

  const updates: Record<string, unknown> = { status: newStatus };

  if (newStatus === "running") {
    updates["started_at"] = new Date().toISOString();
  }

  if (["completed", "failed", "timed_out", "canceled"].includes(newStatus)) {
    updates["completed_at"] = new Date().toISOString();
    if (run.started_at) {
      updates["duration_ms"] =
        new Date().getTime() - new Date(run.started_at).getTime();
    }
  }

  db.update(runs).set(updates).where(eq(runs.id, runId)).run();
}

/**
 * Store criterion results for a run.
 */
export function storeCriterionResults(
  { db }: JRigDatabase,
  runId: number,
  results: Array<{
    criterion_id: string;
    passed: boolean;
    severity: string;
    message: string;
    details?: string;
    method?: string;
  }>,
): void {
  for (const r of results) {
    db.insert(criterionResults)
      .values({
        run_id: runId,
        criterion_id: r.criterion_id,
        passed: r.passed,
        severity: r.severity,
        message: r.message,
        details: r.details ?? null,
        method: r.method ?? null,
      })
      .run();
  }
}

/**
 * Store a run summary.
 */
export function storeRunSummary(
  { db }: JRigDatabase,
  runId: number,
  summary: { total: number; passed: number; warnings: number; errors: number },
): void {
  const score = summary.total > 0 ? summary.passed / summary.total : 0;
  db.insert(runSummaries)
    .values({ run_id: runId, ...summary, score })
    .run();
}

/**
 * Record an artifact reference.
 */
export function recordArtifact(
  { db }: JRigDatabase,
  runId: number,
  artifactType: string,
  filename: string,
  relativePath: string,
  sizeBytes?: number,
): void {
  db.insert(artifacts)
    .values({
      run_id: runId,
      artifact_type: artifactType,
      filename,
      relative_path: relativePath,
      size_bytes: sizeBytes ?? null,
    })
    .run();
}

// ─── Query Helpers ────────────────────────────────────────────────────

/**
 * Get a run by ID with its summary.
 */
export function getRun({ db }: JRigDatabase, runId: number) {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return null;

  const summary = db
    .select()
    .from(runSummaries)
    .where(eq(runSummaries.run_id, runId))
    .get();

  return { ...run, summary: summary ?? null };
}

/**
 * Get recent runs, optionally filtered by skill name.
 */
export function getRecentRuns(
  database: JRigDatabase,
  options: { limit?: number; skillName?: string } = {},
) {
  const { db } = database;
  const limit = options.limit ?? 10;

  if (options.skillName) {
    return db
      .select()
      .from(runs)
      .innerJoin(skillVersions, eq(runs.skill_version_id, skillVersions.id))
      .where(eq(skillVersions.skill_name, options.skillName))
      .orderBy(desc(runs.id))
      .limit(limit)
      .all();
  }

  return db
    .select()
    .from(runs)
    .innerJoin(skillVersions, eq(runs.skill_version_id, skillVersions.id))
    .orderBy(desc(runs.id))
    .limit(limit)
    .all();
}

/**
 * Get criterion results for a run.
 */
export function getRunResults({ db }: JRigDatabase, runId: number) {
  return db
    .select()
    .from(criterionResults)
    .where(eq(criterionResults.run_id, runId))
    .all();
}

/**
 * Get artifacts for a run.
 */
export function getRunArtifacts({ db }: JRigDatabase, runId: number) {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.run_id, runId))
    .all();
}
