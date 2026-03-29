import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/**
 * Skill versions — tracks distinct versions of a skill.
 */
export const skillVersions = sqliteTable("skill_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  skill_name: text("skill_name").notNull(),
  version: text("version").notNull(),
  skill_md_hash: text("skill_md_hash").notNull(),
  created_at: text("created_at").notNull().default("(datetime('now'))"),
});

/**
 * Run lifecycle states:
 * - pending: created, not yet started
 * - running: actively executing checks
 * - completed: finished successfully (may have warnings/failures)
 * - failed: execution error (not a check failure — a system error)
 * - timed_out: exceeded time limit
 * - canceled: manually stopped
 */
export type RunStatus = "pending" | "running" | "completed" | "failed" | "timed_out" | "canceled";

/**
 * Evaluation runs — one per evaluation execution.
 */
export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  skill_version_id: integer("skill_version_id").notNull(),
  status: text("status").notNull().$type<RunStatus>().default("pending"),
  run_type: text("run_type").notNull().default("deterministic"),
  model: text("model"),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  duration_ms: integer("duration_ms"),
  created_at: text("created_at").notNull().default("(datetime('now'))"),
  error_message: text("error_message"),
});

/**
 * Criterion results — one per criterion per run.
 */
export const criterionResults = sqliteTable("criterion_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  run_id: integer("run_id").notNull(),
  criterion_id: text("criterion_id").notNull(),
  passed: integer("passed", { mode: "boolean" }).notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  details: text("details"),
  method: text("method"),
});

/**
 * Run summaries — aggregate counts per run.
 */
export const runSummaries = sqliteTable("run_summaries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  run_id: integer("run_id").notNull().unique(),
  total: integer("total").notNull(),
  passed: integer("passed").notNull(),
  warnings: integer("warnings").notNull(),
  errors: integer("errors").notNull(),
  score: real("score"),
});

/**
 * Artifacts — file-based evidence linked to a run.
 * Actual content is on the filesystem; this tracks metadata.
 */
export const artifacts = sqliteTable("artifacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  run_id: integer("run_id").notNull(),
  artifact_type: text("artifact_type").notNull(),
  filename: text("filename").notNull(),
  relative_path: text("relative_path").notNull(),
  size_bytes: integer("size_bytes"),
  created_at: text("created_at").notNull().default("(datetime('now'))"),
});
