# Epic 02 — Spec Layer and Contract System — Workflow

## Inputs
- Coherent repo structure from Epic 01
- TypeScript / pnpm / Node baseline from Epic 01
- Package skeleton (`packages/core`) from Epic 01

## Flow

```
┌───────────────────────────────────────┐
│  02.1 Design Eval Spec Schema         │
│                                       │
│  Top-level spec shape:                │
│  criteria, context, tiers,            │
│  thresholds, modes                    │
│  Spec vs contract boundary defined    │
└──────────────────┬────────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
┌──────────────────┐ ┌─────────────────────────┐
│ 02.2 Design Eval │ │ 02.3 Define Criterion   │
│ Contract Schema  │ │ & Test Case Schemas     │
│                  │ │                          │
│ Purpose          │ │ Criterion types:         │
│ Trigger bounds   │ │  binary, blocker,        │
│ Blockers         │ │  weighted, deterministic,│
│ Evidence rules   │ │  judge-based, regression,│
│ Safety bounds    │ │  pack-sensitive, baseline │
│ Baseline expects │ │                          │
│ Definition-of-   │ │ Test case tiers:         │
│ done layer       │ │  core, edge, regression, │
└────────┬─────────┘ │  adversarial             │
         │           └────────────┬──────────────┘
         │                        │
         └────────┬───────────────┘
                  │
                  ▼
┌───────────────────────────────────────┐
│  02.4 Build YAML Parsing &            │
│  Validation Utilities                 │
│                                       │
│  Parse eval spec YAML                 │
│  Parse eval contract YAML             │
│  Strict schema validation             │
│  Rich diagnostics on failure          │
│  No silent coercion of broken values  │
└──────────────────┬────────────────────┘
                   │
                   │    ┌───────────────────────────────┐
                   │    │ 02.5 Build SKILL.md Parsing   │
                   │    │ (parallel with 02.4)          │
                   │    │                               │
                   │    │ Frontmatter extraction (AST)  │
                   │    │ Markdown body separation       │
                   │    │ Malformed frontmatter fails    │
                   │    │ No brittle regex hacks         │
                   │    └──────────────┬────────────────┘
                   │                   │
                   └─────────┬─────────┘
                             │
                             ▼
┌───────────────────────────────────────┐
│  02.6 Create Valid & Invalid          │
│  Fixture Sets                         │
│                                       │
│  Valid: spec, contract, criteria,     │
│    test cases, SKILL.md               │
│  Invalid: malformed YAML, missing     │
│    fields, wrong types, inconsistent  │
│    spec/contract combos, bad          │
│    frontmatter                        │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  02.7 Write Author-Facing Schema &    │
│  Contract Documentation               │
│                                       │
│  What is an eval spec                 │
│  What is an eval contract             │
│  How criteria are written             │
│  How test cases are written           │
│  Common validation failures           │
│  Examples and anti-examples           │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  02.8 Capture Evidence & Close        │
│                                       │
│  All schema tests pass                │
│  Valid examples parse successfully    │
│  Invalid examples fail as expected    │
│  Docs aligned to implementation      │
│  End-of-epic AAR produced             │
│  Carry-forward notes for Epic 03     │
└───────────────────────────────────────┘
```

## Outputs
- Formal eval spec schema (machine-readable evaluation definition)
- Formal eval contract schema (human-readable definition-of-done)
- Criterion and test case type schemas
- YAML parsing + validation utilities in `packages/core`
- SKILL.md frontmatter/body parser
- Fixture library (valid + invalid)
- Author-facing documentation
- End-of-epic AAR

## Key Artifacts
- Eval spec schema definition (TypeScript types + Zod/validation)
- Eval contract schema definition
- Criterion schema (binary, blocker, weighted, deterministic, judge-based, regression, pack-sensitive, baseline)
- Test case schema (core, edge, regression, adversarial tiers)
- YAML parser utilities
- SKILL.md parser utilities
- `tests/fixtures/` valid and invalid fixture sets
- Author docs for spec/contract authoring
- Epic 02 AAR document
