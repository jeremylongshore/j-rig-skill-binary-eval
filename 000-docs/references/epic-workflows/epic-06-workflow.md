# Epic 06 — Functional Execution Harness and Observation Layer — Workflow

## Inputs
- Eval spec / contract schemas from Epic 02
- SKILL.md parser (frontmatter + body) from Epic 02
- Package integrity preflight from Epic 03
- Evidence model, persistence, and run lifecycle from Epic 04
- Trigger simulation runner from Epic 05 (skill has been "selected")

## Flow

```
┌───────────────────────────────────────┐
│  06.1 Build Skill Invocation          │
│  Simulator                            │
│                                       │
│  Parsed SKILL.md + functional test    │
│  case -> execution path               │
│  Uses canonical parsed content        │
│  Emits structured execution records   │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  06.2 Implement Execution Context     │
│  & Base-Path Injection                │
│                                       │
│  Inject SKILL.md body context         │
│  Base path handling                   │
│  Related local file content inclusion │
│  Missing/invalid context surfaced     │
│  Aligns with Epic 02 contract/test   │
│  case definitions                     │
└──────────────────┬────────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
┌──────────────────┐ ┌─────────────────────────┐
│ 06.3 Capture Raw │ │ 06.4 Capture Generated  │
│ Outputs &        │ │ Artifacts & File-        │
│ Transcripts      │ │ Producing Outcomes       │
│                  │ │                          │
│ Raw text output  │ │ Artifact file capture    │
│ Execution        │ │ Artifact metadata linked │
│ transcript       │ │ to run                   │
│ Tied to Epic 04  │ │ Missing artifact =       │
│ run records      │ │ explicit failure          │
└────────┬─────────┘ └────────────┬──────────────┘
         │                        │
         │                        ▼
         │           ┌─────────────────────────┐
         │           │ 06.5 Implement Artifact │
         │           │ Extraction & Post-      │
         │           │ Processing Helpers      │
         │           │                          │
         │           │ Extract text/content     │
         │           │ from generated artifacts │
         │           │ Initial format support   │
         │           │ Unsupported types fail   │
         │           │ clearly                  │
         │           └────────────┬──────────────┘
         │                        │
         └────────┬───────────────┘
                  │
                  ▼
┌───────────────────────────────────────┐
│  06.6 Define & Persist the Observed   │
│  Outcome Model                        │
│                                       │
│  ┌─────────────────────────────────┐  │
│  │ Observed Outcome Record         │  │
│  │ ├─ raw output / artifact result │  │
│  │ ├─ success / failure / partial  │  │
│  │ ├─ artifact presence / absence  │  │
│  │ ├─ extracted artifact content   │  │
│  │ └─ execution metadata refs      │  │
│  └─────────────────────────────────┘  │
│                                       │
│  Persisted via Epic 04 evidence model │
│  Source of truth for later judgment   │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  06.7 Capture Execution Timing,       │
│  Token, Cost & Timeout Metadata       │
│                                       │
│  Timing data                          │
│  Token usage metrics                  │
│  Cost estimates                       │
│  Timeout / interrupted state capture  │
│  Linked to run + observed outcome     │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  06.8 Document Simulation Limits      │
│  & Close                              │
│                                       │
│  Demonstrated on realistic samples    │
│  Text-first and artifact-producing    │
│  cases shown                          │
│  Honest docs on simulation vs live    │
│  End-of-epic AAR produced             │
│  Carry-forward for Epics 07-09       │
└───────────────────────────────────────┘
```

## Outputs
- Skill invocation simulator
- Execution context / base-path injection
- Raw output + transcript capture
- Artifact capture + extraction helpers
- Observed outcome model (canonical truth for judgment)
- Execution metadata (timing, tokens, cost, timeout states)
- Persisted functional execution evidence
- Carry-forward: observed outcomes for Epic 07 judgment, Epic 08 scoring, Epic 09 optimization

## Key Artifacts
- Skill invocation simulator module
- Execution context injector
- Raw output capture utility
- Artifact capture + metadata linker
- Artifact extraction helpers (initial format support)
- Observed outcome model / schema
- Execution metadata capture module
- Persisted execution run records + observed outcomes
- Simulation-limits documentation
- Epic 06 AAR document
