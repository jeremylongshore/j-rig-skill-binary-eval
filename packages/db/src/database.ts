import type BetterSqlite3 from "better-sqlite3";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export interface JRigDatabase {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: BetterSqlite3.Database;
  close: () => void;
}

/**
 * SQL to bootstrap the database schema.
 * Drizzle handles queries, but we create tables directly for simplicity
 * (no migration tooling needed for a local-first CLI tool).
 */
const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS skill_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_name TEXT NOT NULL,
    version TEXT NOT NULL,
    skill_md_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_version_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    run_type TEXT NOT NULL DEFAULT 'deterministic',
    model TEXT,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    error_message TEXT,
    FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id)
  );

  CREATE TABLE IF NOT EXISTS criterion_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    criterion_id TEXT NOT NULL,
    passed INTEGER NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    method TEXT,
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );

  CREATE TABLE IF NOT EXISTS run_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL UNIQUE,
    total INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    warnings INTEGER NOT NULL,
    errors INTEGER NOT NULL,
    score REAL,
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    artifact_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    size_bytes INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );

  -- Skill usage events — intake fact table for the j-rig ingest-skill verb
  -- (ISEDC DR-103 D1/D2/D5). The tenant_id column lands in this FIRST CREATE
  -- TABLE per DR-103 D2 B2.1 (database.ts is CREATE-IF-NOT-EXISTS only — no ALTER
  -- path — so a future column add cannot retrofit cleanly; the multi-tenancy slot
  -- is reserved now). NULL tenant_id = the single-tenant/global bucket, never
  -- pooled cross-tenant (D2 B2.2). cass_passed = 0 rows are persisted-but-excluded.
  CREATE TABLE IF NOT EXISTS skill_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source TEXT NOT NULL,
    cass_score REAL NOT NULL,
    cass_passed INTEGER NOT NULL,
    tenant_id TEXT,
    recorded_at TEXT NOT NULL
  );

  -- Skill human reviews — intake fact table for the j-rig review verb.
  -- governance_class is always 'curated-signal' (NOT a signed human-review/v1
  -- predicate; DR-103 D3 B3.2 / doc 072 R6). tenant_id reserved here per D2 B2.1.
  CREATE TABLE IF NOT EXISTS skill_human_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL,
    thumbs_up INTEGER NOT NULL,
    rationale TEXT,
    reviewer TEXT NOT NULL,
    governance_class TEXT NOT NULL,
    tenant_id TEXT,
    recorded_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_runs_skill_version ON runs(skill_version_id);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS idx_criterion_results_run ON criterion_results(run_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
  CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage_events(skill_id);
  CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_passed ON skill_usage_events(skill_id, cass_passed);
  CREATE INDEX IF NOT EXISTS idx_skill_reviews_skill ON skill_human_reviews(skill_id);
`;

/**
 * Create and initialize a j-rig database.
 *
 * @param dbPath - Path to SQLite file. Use ":memory:" for testing.
 */
export function createDatabase(dbPath: string): JRigDatabase {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(CREATE_TABLES);

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
