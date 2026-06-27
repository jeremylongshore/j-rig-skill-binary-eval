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

/**
 * Skill usage events — local intake fact table for the `j-rig ingest-skill` verb
 * (epic intent-eval-lab#206, ISEDC DR-103 D1/D2/D5).
 *
 * Append-only. Every row carries a CASS session-quality verdict (`cass_score` +
 * `cass_passed`): a row that FAILS the gate is PERSISTED (`cass_passed = false`)
 * but EXCLUDED from adoption rollups — the persist-but-exclude discipline that
 * makes load-to-inflate visible (spec Item 5). `source` is the anti-gaming
 * provenance split (`ci` gate-anchored vs `plugin` unverified, DR-103 D5 B5.3).
 * `tenant_id` is OPTIONAL (NULL = the single-tenant/global bucket, never pooled
 * cross-tenant — DR-103 D2 B2.2) and lands in the FIRST CREATE TABLE per B2.1.
 */
export const skillUsageEvents = sqliteTable("skill_usage_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  skill_id: text("skill_id").notNull(),
  session_id: text("session_id").notNull(),
  source: text("source").notNull().$type<"ci" | "plugin">(),
  cass_score: real("cass_score").notNull(),
  cass_passed: integer("cass_passed", { mode: "boolean" }).notNull(),
  tenant_id: text("tenant_id"),
  recorded_at: text("recorded_at").notNull(),
});

/**
 * Skill human reviews — local intake fact table for the `j-rig review` verb.
 *
 * Append-only CURATED-SIGNAL rows: a developer thumb + open-ended NON-COMPARABLE
 * free-text rationale (DR-103 C3 B6.3). `governance_class` is always
 * `"curated-signal"` — explicitly NOT the signed in-toto `human-review/v1`
 * predicate and never a trust root (DR-103 D3 B3.2 / doc 072 R6). `tenant_id`
 * OPTIONAL, NULL = global bucket; lands in the FIRST CREATE TABLE per B2.1.
 */
export const skillHumanReviews = sqliteTable("skill_human_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  skill_id: text("skill_id").notNull(),
  thumbs_up: integer("thumbs_up", { mode: "boolean" }).notNull(),
  rationale: text("rationale"),
  reviewer: text("reviewer").notNull(),
  governance_class: text("governance_class").notNull().$type<"curated-signal">(),
  tenant_id: text("tenant_id"),
  recorded_at: text("recorded_at").notNull(),
});
