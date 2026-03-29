# Epic 04 — After Action Report

**Date:** 2026-03-29
**Epic:** 04 — Evidence Layer, Persistence, and Run Lifecycle
**Status:** Complete

## What Was Delivered

### Data Model (`packages/db/src/schema.ts`)
- `skill_versions` — tracks distinct skill versions by content hash
- `runs` — evaluation runs with lifecycle status, timing, model
- `criterion_results` — per-criterion pass/fail per run
- `run_summaries` — aggregate counts and score per run
- `artifacts` — file-based evidence metadata linked to runs

### SQLite Persistence (`packages/db/src/database.ts`)
- `createDatabase()` — zero-config local init with WAL mode
- `CREATE TABLE IF NOT EXISTS` bootstrap (no migration tooling needed)
- Indexes on runs(skill_version_id, status), criterion_results(run_id), artifacts(run_id)
- In-memory mode (`:memory:`) for testing

### Run Lifecycle (`packages/db/src/lifecycle.ts`)
- 6 states: pending, running, completed, failed, timed_out, canceled
- Explicit transition rules (pending→running→completed/failed/timed_out/canceled)
- Terminal state detection, allowed transition queries

### Evidence Persistence (`packages/db/src/evidence.ts`)
- `getOrCreateSkillVersion()` — dedup by content hash
- `createRun()` / `transitionRun()` — lifecycle management with timestamps
- `storeCriterionResults()` / `storeRunSummary()` — deterministic evidence
- `recordArtifact()` — filesystem metadata
- Query helpers: `getRun()`, `getRecentRuns()`, `getRunResults()`, `getRunArtifacts()`

### Tests
- 78 total (20 new): database init, skill version dedup, lifecycle transitions, evidence CRUD, query helpers

## Quality Gate Evidence

```
pnpm run check → PASS
  lint:      0 errors
  typecheck: 0 errors
  test:      78/78 passed (10 test files)
  build:     3/3 packages built (db: 9.2 KB + 27.8 KB .d.ts)
```

## Dependencies Added
- `better-sqlite3` + `@types/better-sqlite3` — native SQLite
- `drizzle-orm` + `drizzle-kit` — type-safe query builder

## What Epics 05+ Inherit
- `createDatabase(":memory:")` for testing, `createDatabase("path")` for real use
- `createRun()` → `transitionRun("running")` → store results → `transitionRun("completed")` is the canonical flow
- `PackageReport` from Epic 03 maps to `storeCriterionResults()` + `storeRunSummary()`
- Artifact filesystem paths stored in `artifacts` table, actual files managed by caller
- Query helpers ready for CLI (Epic 08), dashboard (Epic 10), regression compare (Epic 08)
