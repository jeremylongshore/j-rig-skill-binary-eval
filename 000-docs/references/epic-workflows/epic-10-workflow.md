# Epic 10 — Team Product, Eval Packs, and Drift Operations — Workflow

## Inputs
- All prior epics (01-09) provide the full system foundation:
  - Repo structure and tooling (Epic 01)
  - Spec / contract schema system (Epic 02)
  - Package integrity / deterministic preflight (Epic 03)
  - Evidence model, SQLite persistence, run lifecycle (Epic 04)
  - Trigger simulation, metrics, pack confusion analysis (Epic 05)
  - Functional execution, observed outcomes, artifact capture (Epic 06)
  - Judgment layer, calibration, model matrix (Epic 07)
  - Regression comparison, baseline, scoring, CLI, CI gate (Epic 08)
  - Optimizer, experiment engine, experiment history (Epic 09)

## Flow

```
┌───────────────────────────────────────┐
│  10.1 Build Initial Team-Facing       │
│  Dashboard / Read Surface             │
│                                       │
│  Browsable interface for:             │
│   skills, runs, recommendations,      │
│   compare results                     │
│  Built on canonical evidence model    │
│  (no shadow logic)                    │
└──────────────────┬────────────────────┘
                   │
          ┌────────┼──────────────────────────────┐
          │        │                              │
          ▼        ▼                              ▼
┌────────────────┐ ┌──────────────────┐ ┌─────────────────────┐
│ 10.2 Expose    │ │ 10.3 Create      │ │ 10.4 Add Org/Team   │
│ Experiment &   │ │ Starter Reusable │ │ Integration Hooks    │
│ Recommendation │ │ Eval Packs       │ │ or API Surfaces     │
│ History        │ │                  │ │                      │
│                │ │ Categories:      │ │ Internal API for key │
│ What changed?  │ │ ├─ doc creation  │ │ data/actions         │
│ Why?           │ │ ├─ code gen      │ │ Supports team        │
│ What happened? │ │ ├─ data analysis │ │ workflows beyond     │
│ Accepted or    │ │ ├─ workflow orch │ │ local CLI/CI         │
│ rejected?      │ │ └─ safety /     │ │ Scoped to current    │
│                │ │   tool-using    │ │ product needs         │
│ Aligned with   │ │                  │ │ Security bounds      │
│ canonical      │ │ Schema-valid     │ │ documented           │
│ evidence       │ │ Documented       │ │                      │
│ structures     │ │ Inspectable      │ │                      │
└────────┬───────┘ └────────┬─────────┘ └──────────┬──────────┘
         │                  │                       │
         │                  │                       │
         │     ┌────────────┘                       │
         │     │    ┌───────────────────────────────┘
         │     │    │
         ▼     │    │
┌──────────────┴────┴───────────────────┐
│  10.5 Implement Scheduled Drift       │
│  Reevaluation Workflows               │
│                                       │
│  Periodic reevaluation support        │
│  Drift runs distinguishable from      │
│  ad hoc / manual runs                 │
│  Surface changes from prior known-    │
│  good states                          │
│  Ties into evidence / governance      │
│  model                                │
│                                       │
│  ┌─────────────────────────────────┐  │
│  │ Model change / prompt shift     │  │
│  │        │                        │  │
│  │        ▼                        │  │
│  │ Scheduled reeval run            │  │
│  │        │                        │  │
│  │        ▼                        │  │
│  │ Compare against known-good      │  │
│  │        │                        │  │
│  │        ▼                        │  │
│  │ ◇ Drift detected?             │  │
│  │ ├─NO──► Skill still healthy     │  │
│  │ └─YES─► Flag for review         │  │
│  └─────────────────────────────────┘  │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  10.6 Implement Obsolete-Review       │
│  Workflow & Operational Triage        │
│                                       │
│  ◇ Skill flagged obsolete /          │
│    low-value / drifted?               │
│    │                                  │
│    ▼                                  │
│  Operational triage:                  │
│   ├─ skill still helps    ► KEEP     │
│   ├─ skill barely helps   ► NARROW   │
│   ├─ skill should merge   ► MERGE    │
│   └─ skill should retire  ► RETIRE   │
│                                       │
│  Connects baseline, drift, and        │
│  recommendation evidence              │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  10.7 Document Operating Model &      │
│  Close                                │
│                                       │
│  Team-facing surfaces demonstrated    │
│  Eval packs documented and usable     │
│  Scheduled reevaluation demonstrated  │
│  Obsolete-review workflow demonstrated│
│  Operational docs created             │
│  End-of-epic AAR produced             │
│  Post-v1 roadmap written              │
└───────────────────────────────────────┘
```

## Outputs
- Team-facing dashboard / read surface
- Experiment + recommendation history views
- Starter reusable eval packs (5 categories)
- Organization / team integration API surface
- Scheduled drift reevaluation workflow
- Obsolete-review operational triage workflow
- Operational documentation for ongoing maintenance
- Post-v1 roadmap
- Final end-of-epic AAR

## Key Artifacts
- Dashboard / team read surface (`packages/dashboard`)
- Experiment history browser
- Recommendation history browser
- Eval packs: document-creation, code-generation, data-analysis, workflow-orchestration, safety-tool-using (`eval-packs/`)
- Internal API / integration surface
- Scheduled reevaluation runner / config
- Drift comparison output format
- Obsolete-review workflow (keep/narrow/merge/retire states)
- Operational maintenance documentation
- Post-v1 roadmap document
- Epic 10 AAR document
