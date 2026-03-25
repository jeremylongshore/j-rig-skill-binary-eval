# Epic 01 — Repo Foundation and Operating Standard — Workflow

## Inputs
- None (this is the foundation epic)
- Existing repo state (may contain partial setup, stale scaffolding, or drift)

## Flow

```
┌───────────────────────────────────────┐
│  01.1 Audit Current Repo State        │
│  Inspect .git/, .beads/, docs,        │
│  config, packages, scripts            │
│  Classify: keep / repair / replace    │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  01.2 Establish Workspace & Package   │
│  Skeleton                             │
│  ┌─────────────────────────────────┐  │
│  │ packages/cli                    │  │
│  │ packages/core                   │  │
│  │ packages/db                     │  │
│  │ packages/dashboard (placeholder)│  │
│  │ eval-packs/                     │  │
│  │ tests/                          │  │
│  │ 000-docs/                       │  │
│  └─────────────────────────────────┘  │
└──────────────────┬────────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
┌──────────────────┐ ┌─────────────────────────┐
│ 01.3 Install TS  │ │ 01.5 Create Canonical    │
│ & Node Baseline  │ │ Docs & Operating         │
│                  │ │ Guidance                  │
│ package.json     │ │                           │
│ pnpm-workspace   │ │ README.md                 │
│ tsconfig.json    │ │ CLAUDE.md                 │
│ Node 20+         │ │ Epic reference docs       │
└────────┬─────────┘ │ Master blueprint index    │
         │           └────────────┬──────────────┘
         │                        │
         ▼                        │
┌──────────────────┐              │
│ 01.4 Add Quality │              │
│ Guardrails &     │              │
│ Dev Scripts      │              │
│                  │              │
│ Linting (ESLint) │              │
│ Formatting       │              │
│ Test runner      │              │
│ Workspace scripts│              │
└────────┬─────────┘              │
         │                        │
         ├────────────────────────┘
         │
         ▼
┌───────────────────────────────────────┐
│  01.6 Initialize Repo-Local Beads     │
│  & 10-Epic Tracking Structure         │
│                                       │
│  .beads/ directory                    │
│  10 top-level epics created           │
│  Epic 01 child tasks created          │
│  Dependencies reflect execution order │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  01.7 Capture Evidence & Close        │
│                                       │
│  Verify repo structure                │
│  Execute baseline scripts             │
│  Review docs alignment                │
│  Update Beads statuses                │
│  Produce end-of-epic AAR             │
│  Document carry-forward items         │
└───────────────────────────────────────┘
```

## Outputs
- Coherent pnpm monorepo workspace structure
- TypeScript / Node 20+ / pnpm baseline configuration
- Lint / format / test guardrails
- README.md, CLAUDE.md, epic reference docs
- Initialized .beads/ with 10-epic tracking structure
- End-of-epic AAR with evidence
- Carry-forward items for Epic 02

## Key Artifacts
- `package.json` (root workspace)
- `pnpm-workspace.yaml`
- `tsconfig.json`
- `packages/cli/`, `packages/core/`, `packages/db/`, `packages/dashboard/`
- `eval-packs/`
- `tests/`
- `000-docs/epics/`
- `README.md`
- `CLAUDE.md`
- `.beads/`
- Epic 01 AAR document
