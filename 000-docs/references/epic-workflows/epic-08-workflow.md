# Epic 08 — Regression, Baseline, Scoring, CLI, and CI Gate — Workflow

## Inputs
- Eval spec / contract schemas from Epic 02
- Deterministic results from Epic 03
- Evidence model, persistence, query helpers from Epic 04
- Trigger metrics and results from Epic 05
- Observed outcomes and execution metadata from Epic 06
- Criterion-level judgments (yes/no/unsure, per-model) from Epic 07

## Flow

```
┌───────────────────────────────────────────────────────────────┐
│                     COMPARISON LAYER                          │
│                                                               │
│  ┌─────────────────────┐     ┌──────────────────────────┐    │
│  │ 08.1 Regression     │     │ 08.3 Baseline / No-Skill │    │
│  │ Comparison Engine   │     │ Comparison               │    │
│  │                     │     │                          │    │
│  │ Compare run N vs    │     │ Compare skill-on vs      │    │
│  │ run N-1             │     │ skill-off runs           │    │
│  │                     │     │                          │    │
│  │ Identify:           │     │ Identify:                │    │
│  │  newly passing      │     │  skill clearly helps     │    │
│  │  newly failing      │     │  skill barely helps      │    │
│  │  stable passes      │     │  skill harms             │    │
│  │  stable failures    │     │  skill appears obsolete  │    │
│  │                     │     │                          │    │
│  │ Criterion-level +   │     │ Baseline deltas stored   │    │
│  │ test-case-level     │     │ explicitly               │    │
│  └──────────┬──────────┘     └────────────┬─────────────┘    │
│             │                             │                   │
└─────────────┼─────────────────────────────┼───────────────────┘
              │                             │
              ▼                             │
┌──────────────────────┐                    │
│ 08.2 Enforce Sacred  │                    │
│ Regression & Blocker │                    │
│ Failure Rules        │                    │
│                      │                    │
│ ◇ Sacred regression │                    │
│   broken?            │                    │
│   └─YES─► BLOCK      │                    │
│                      │                    │
│ ◇ Blocker criterion │                    │
│   newly failed?      │                    │
│   └─YES─► BLOCK      │                    │
│                      │                    │
│ Blockers cannot be   │                    │
│ averaged away        │                    │
└──────────┬───────────┘                    │
           │                                │
           └────────────┬───────────────────┘
                        │
                        ▼
┌───────────────────────────────────────┐
│  08.4 Transparent Score Aggregation   │
│  & Launch-Readiness Logic             │
│                                       │
│  Explicit formula:                    │
│   weighted criterion scores           │
│   + blocker pass/fail status          │
│   + sacred regression status          │
│   + baseline signal contribution      │
│                                       │
│  Deterministic, test-covered          │
│  No silent override for blockers      │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  08.5 Implement Recommendation        │
│  Outcomes                             │
│                                       │
│  ┌──────────────────────────────┐     │
│  │  Evidence + Scoring          │     │
│  │         │                    │     │
│  │         ▼                    │     │
│  │  ◇ Blocker/sacred failed?   │     │
│  │  ├─YES─► BLOCK              │     │
│  │  │                          │     │
│  │  ◇ Baseline value negative? │     │
│  │  ├─YES─► OBSOLETE-REVIEW    │     │
│  │  │                          │     │
│  │  ◇ Warnings present?       │     │
│  │  ├─YES─► WARN               │     │
│  │  │                          │     │
│  │  └─NO──► PASS               │     │
│  └──────────────────────────────┘     │
│                                       │
│  Reasons explicit and persisted       │
└──────────────────┬────────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
┌──────────────────┐ ┌─────────────────────────┐
│ 08.6 Implement   │ │ 08.7 Implement CI/PR    │
│ Primary CLI      │ │ Gating & Report Output  │
│ Workflows        │ │                          │
│                  │ │ Evaluate changed skills   │
│ j-rig init       │ │ in CI                    │
│ j-rig run        │ │ Output: recommendation   │
│ j-rig compare    │ │ state + signals          │
│ j-rig ci         │ │ Blocker/sacred fails =   │
│                  │ │ CI failure               │
│ Readable output  │ │ PR-friendly report       │
│ Helpful errors   │ │ format                   │
└────────┬─────────┘ └────────────┬──────────────┘
         │                        │
         └────────┬───────────────┘
                  │
                  ▼
┌───────────────────────────────────────┐
│  08.8 Persist Compare/Recommendation  │
│  Evidence & Close                     │
│                                       │
│  Compare outputs persisted            │
│  Recommendation objects persisted     │
│  CLI + CI workflows demonstrated      │
│  End-of-epic AAR produced             │
│  Carry-forward for Epics 09, 10     │
└───────────────────────────────────────┘
```

## Outputs
- Regression comparison engine (run-over-run diff)
- Sacred regression + blocker enforcement (non-negotiable blocks)
- Baseline / no-skill comparison (value-add measurement)
- Transparent score aggregation (no black-box magic)
- Recommendation outcomes: PASS, WARN, BLOCK, OBSOLETE-REVIEW
- CLI workflows: `init`, `run`, `compare`, `ci`
- CI/PR gating and report output
- Persisted comparison and recommendation evidence
- Carry-forward: governance outputs for Epic 09 optimizer, Epic 10 team product

## Key Artifacts
- Regression comparison engine module
- Sacred regression / blocker enforcement module
- Baseline comparator module
- Score aggregation / launch-readiness calculator
- Recommendation engine (pass/warn/block/obsolete-review)
- CLI command implementations (`packages/cli`)
- CI workflow configuration (`.github/workflows/`)
- PR report template / output formatter
- Persisted compare + recommendation records
- Governance documentation
- Epic 08 AAR document
