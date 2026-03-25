# Epic 03 — Package Integrity and Deterministic Checks — Workflow

## Inputs
- Eval spec / contract schemas from Epic 02
- YAML parsing + validation utilities from Epic 02
- SKILL.md parser from Epic 02
- Criterion schema definitions from Epic 02

## Flow

```
┌───────────────────────────────────────┐
│  03.1 Build Package Integrity Checker │
│                                       │
│  Locate & validate SKILL.md           │
│  Use Epic 02 canonical parsers        │
│  Identify missing required pieces     │
│  Return structured result objects     │
└──────────────────┬────────────────────┘
                   │
    ┌──────────────┼──────────────┬──────────────┐
    │              │              │              │
    ▼              ▼              ▼              ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ 03.2     │ │ 03.3     │ │ 03.4     │ │ 03.5     │
│ Determin-│ │ Validate │ │ Descript-│ │ Oversize/ │
│ istic    │ │ Referenc-│ │ ion      │ │ Underspec │
│ Check    │ │ ed Files │ │ Quality  │ │ Heuristic │
│ Registry │ │ & Pkg    │ │ Heurist- │ │ Checks   │
│          │ │ Relation-│ │ ics      │ │          │
│ Patterns:│ │ ships    │ │          │ │ Bloated  │
│ contains │ │          │ │ Vague?   │ │ pkg?     │
│ not-     │ │ Existing │ │ Too      │ │ Thin     │
│ contains │ │ refs?    │ │ short?   │ │ instruc- │
│ regex    │ │ Broken   │ │ Missing  │ │ tions?   │
│ struct   │ │ refs?    │ │ intent?  │ │ Missing  │
│ output   │ │ Ambig.?  │ │          │ │ examples?│
└────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
     │            │            │            │
     └────────────┴─────┬──────┴────────────┘
                        │
                        ▼
          ┌─────────────────────────────┐
          │  ◇ Result Classification    │
          │                             │
          │  Hard failure?              │
          │  ├► Missing SKILL.md        │
          │  ├► Malformed frontmatter   │
          │  ├► Missing required fields │
          │  └► Broken required refs    │
          │                             │
          │  Warning?                   │
          │  ├► Vague description       │
          │  ├► Thin package            │
          │  ├► Oversized instructions  │
          │  └► Missing helpful examples│
          └─────────────┬───────────────┘
                        │
                        ▼
┌───────────────────────────────────────┐
│  03.6 Produce Deterministic Reporting │
│  Output                              │
│                                       │
│  Machine-readable structured results  │
│  Human-readable summary format        │
│  Clear failure / warning / pass       │
│  distinction                          │
│  Compatible with Epic 04 persistence  │
│  Compatible with Epic 08 CLI/CI       │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  03.7 Create Deterministic Fixtures   │
│  & Failure Coverage                   │
│                                       │
│  Fixtures: missing SKILL.md,          │
│  malformed frontmatter, missing       │
│  fields, broken refs, vague desc,     │
│  oversized pkg, underspec pkg,        │
│  deterministic rule pass/fail         │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  03.8 Capture Evidence & Close        │
│                                       │
│  Package integrity tests pass         │
│  Broken packages fail clearly         │
│  Docs explain deterministic scope     │
│  End-of-epic AAR produced             │
│  Carry-forward notes for Epic 04-06   │
└───────────────────────────────────────┘
```

## Outputs
- Package integrity checker (zero-API-cost preflight gate)
- Deterministic check registry (reusable, extensible)
- Structured result objects with hard-failure / warning / pass semantics
- Human-readable + machine-readable reporting output
- Fixture library for common package failures
- Carry-forward: deterministic result shapes for Epic 04 persistence

## Key Artifacts
- Package integrity checker module
- Deterministic check registry (contains, not-contains, regex, struct-output)
- Reference validation logic
- Description quality heuristic module
- Oversize / underspec heuristic module
- Deterministic report output format
- Fixtures: broken packages, valid packages, warning-heavy packages
- Epic 03 AAR document
