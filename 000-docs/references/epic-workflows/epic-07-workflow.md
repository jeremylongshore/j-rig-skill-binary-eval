# Epic 07 — Judgment Layer, Calibration, and Model Matrix — Workflow

## Inputs
- Criterion schemas from Epic 02
- Deterministic check registry from Epic 03
- Evidence model and persistence from Epic 04
- Trigger results and metrics from Epic 05
- Observed outcomes (text + artifacts) from Epic 06

## Flow

```
┌───────────────────────────────────────┐
│  07.1 Build Binary Judge Engine       │
│                                       │
│  Evaluate observed outcome against    │
│  criterion                            │
│  Constrained result space:            │
│    yes │ no │ unsure                  │
│  Short evidence/rationale for trace   │
│  Reusable across trigger, functional, │
│  and baseline judgments               │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  07.2 Enforce Strict Machine-Readable │
│  Parsing of Judge Outputs             │
│                                       │
│  Validate against strict schema       │
│  Invalid outputs fail clearly         │
│  No silent coercion of malformed      │
│  judge responses                      │
└──────────────────┬────────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
┌──────────────────┐ ┌─────────────────────────┐
│ 07.3 Implement   │ │ 07.4 Add Judge Prompt   │
│ Deterministic-   │ │ Templates & Phrasing    │
│ First Judgment   │ │ Rotation                │
│ Flow             │ │                          │
│                  │ │ Multiple phrased         │
│ ◇ Can criterion │ │ variants per criterion   │
│   be resolved   │ │ Organized templates      │
│   deterministic-│ │ Explicit rotation        │
│   ally?         │ │ behavior                 │
│   │             │ │ Reduces overfitting to   │
│   ├─YES─► Use   │ │ one evaluator wording    │
│   │  Epic 03    │ │                          │
│   │  checks     │ └────────────┬──────────────┘
│   │             │              │
│   └─NO──► Send  │              │
│      to LLM     │              │
│      judge      │              │
│                  │              │
│ Result indicates │              │
│ how judgment was │              │
│ reached          │              │
└────────┬─────────┘              │
         │                        │
         └────────┬───────────────┘
                  │
                  ▼
┌───────────────────────────────────────┐
│  07.5 Implement Calibration &         │
│  Golden-Case Validation               │
│                                       │
│  Run known-good judgment examples     │
│  before/during important eval flows   │
│                                       │
│  ◇ Calibration pass?                 │
│    ├─YES─► Proceed with confidence    │
│    └─NO──► Surface calibration        │
│            failure clearly            │
│                                       │
│  Store calibration metadata           │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  07.6 Implement Disagreement &        │
│  Unsure Handling                      │
│                                       │
│  "unsure" = real outcome, not a bug   │
│  Disagreement between deterministic   │
│  & LLM judge represented clearly      │
│  Disagreement between judge variants  │
│  tracked                              │
│  Unclear results stored structured    │
│  for later policy handling            │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  07.7 Implement Per-Model Judgment    │
│  Matrix Support                       │
│                                       │
│  ┌─────────────────────────────────┐  │
│  │  Model Matrix Execution         │  │
│  │                                 │  │
│  │  Claude Opus ──► judgment set A │  │
│  │  Claude Sonnet ► judgment set B │  │
│  │  Claude Haiku ─► judgment set C │  │
│  │  ...                            │  │
│  └─────────────────────────────────┘  │
│                                       │
│  Results stored with model identity   │
│  Per-model summaries / comparisons    │
│  Model-specific differences           │
│  retrievable                          │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  07.8 Persist Judgment Evidence       │
│  & Close                              │
│                                       │
│  All judgment types persisted:        │
│  deterministic, LLM-judge, unsure,   │
│  disagreement, calibration-aware,     │
│  per-model tagged                     │
│  End-of-epic AAR produced             │
│  Carry-forward for Epics 08-10       │
└───────────────────────────────────────┘
```

## Outputs
- Binary judge engine (yes / no / unsure)
- Strict machine-readable judge output validation
- Deterministic-first judgment routing (cheap checks before API calls)
- Judge prompt templates with phrasing rotation
- Calibration / golden-case validation workflow
- Disagreement and unsure handling
- Per-model judgment matrix support
- Persisted judgment evidence in canonical evidence system
- Carry-forward: criterion-level judgments for Epic 08 scoring, Epic 09 optimization

## Key Artifacts
- Binary judge engine module
- Judge output schema + strict parser/validator
- Deterministic-first routing logic
- Judge prompt template files (multiple phrasings per criterion)
- Calibration workflow module + golden-case fixtures
- Disagreement handler module
- Model matrix execution support module
- Persisted judgment records (model-tagged, calibration-aware)
- Judgment layer documentation
- Epic 07 AAR document
