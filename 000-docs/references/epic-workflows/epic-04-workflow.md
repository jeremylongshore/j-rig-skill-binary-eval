# Epic 04 — Evidence Layer, Persistence, and Run Lifecycle — Workflow

## Inputs
- Deterministic result objects from Epic 03
- Reporting output format from Epic 03
- Eval spec / contract schemas from Epic 02
- Repo structure and packages/db from Epic 01

## Flow

```
┌───────────────────────────────────────┐
│  04.1 Design Canonical Run &          │
│  Evidence Data Model                  │
│                                       │
│  Core entities:                       │
│   skill ─► version ─► run            │
│   run ─► outputs ─► criteria results  │
│   run ─► artifacts                    │
│                                       │
│  DB vs filesystem split decision      │
│  Future-proofed for compare/baseline/ │
│  optimizer use                        │
└──────────────────┬────────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
┌──────────────────┐ ┌─────────────────────────┐
│ 04.2 Implement   │ │ 04.4 Define Filesystem  │
│ SQLite-First     │ │ Storage Layout           │
│ Persistence      │ │                          │
│                  │ │ Predictable dir structure │
│ Local zero-config│ │ for run artifacts         │
│ Core tables/     │ │ Raw outputs + extracted   │
│ schema           │ │ files in stable locations │
│ Migration        │ │ Artifact paths linked to  │
│ baseline         │ │ DB run records            │
└────────┬─────────┘ └────────────┬──────────────┘
         │                        │
         ▼                        │
┌──────────────────┐              │
│ 04.3 Define &    │              │
│ Implement Run    │              │
│ Lifecycle States │              │
│                  │              │
│ pending          │              │
│   │              │              │
│   ▼              │              │
│ running          │              │
│   │              │              │
│   ├─► completed  │              │
│   ├─► failed     │              │
│   ├─► blocked    │              │
│   ├─► timed_out  │              │
│   └─► canceled   │              │
└────────┬─────────┘              │
         │                        │
         └────────┬───────────────┘
                  │
                  ▼
┌───────────────────────────────────────┐
│  04.5 Implement Evidence              │
│  Serialization & Structured Result    │
│  Persistence                          │
│                                       │
│  Serialize Epic 03 deterministic      │
│  results into DB                      │
│  Design format for future trigger /   │
│  functional / judge outputs           │
│  Preserve detail for later compare    │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  04.6 Build Readback & Query Helpers  │
│                                       │
│  Queries:                             │
│   ├─ recent runs                      │
│   ├─ runs by skill                    │
│   ├─ runs by version                  │
│   ├─ outputs/artifacts tied to run    │
│   └─ criterion results tied to run    │
│                                       │
│  Clean API for CLI, CI, compare,      │
│  dashboard consumers                  │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  04.7 Add Persistence Fixtures &      │
│  Failure Coverage                     │
│                                       │
│  Tests: DB init, run persistence,     │
│  artifact path recording,             │
│  failed/incomplete runs,              │
│  lifecycle edge cases,                │
│  readback correctness                 │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  04.8 Document Evidence Model &       │
│  Close                                │
│                                       │
│  DB + filesystem persistence demoed   │
│  Deterministic results stored &       │
│  retrievable                          │
│  End-of-epic AAR produced             │
│  Carry-forward for Epics 05, 06, 08  │
└───────────────────────────────────────┘
```

## Outputs
- Canonical run / evidence data model
- SQLite-backed persistence layer (packages/db)
- Run lifecycle state machine (pending -> running -> completed/failed/blocked/timed_out/canceled)
- Filesystem artifact storage layout
- Evidence serialization utilities
- Query / readback helpers for prior runs
- Carry-forward: evidence model for Epics 05, 06, 08, 09

## Key Artifacts
- SQLite schema / migration files
- Run entity tables (skills, versions, runs, outputs, criteria_results, artifacts)
- Run lifecycle state model
- Artifact storage directory convention (e.g., `data/runs/<run-id>/artifacts/`)
- Evidence serializer utilities
- Query helper module (recent runs, by-skill, by-version, by-run-id)
- DB bootstrap / initialization script
- Epic 04 AAR document
