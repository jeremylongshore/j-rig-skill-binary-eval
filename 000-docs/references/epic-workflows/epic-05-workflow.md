# Epic 05 — Trigger Harness and Skill Roster Simulation — Workflow

## Inputs
- Eval spec / contract schemas from Epic 02
- SKILL.md parser from Epic 02
- Package integrity checker from Epic 03 (preflight gate)
- Evidence model, SQLite persistence, and run lifecycle from Epic 04
- Sibling-skill and context schema definitions from Epic 02

## Flow

```
┌───────────────────────────────────────┐
│  05.1 Build Available-Skills          │
│  Roster Builder                       │
│                                       │
│  Target skill + optional siblings     │
│  Uses canonical parsed skill metadata │
│  Stable, reusable roster format       │
└──────────────────┬────────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
┌──────────────────┐ ┌─────────────────────────┐
│ 05.2 Define      │ │ 05.3 Define Trigger     │
│ Sibling-Skill &  │ │ Test Case Formats       │
│ Pack Context     │ │ & Categories            │
│                  │ │                          │
│ Include siblings │ │ Types:                   │
│ from spec/       │ │  ├─ should-trigger       │
│ context defs     │ │  ├─ should-not-trigger   │
│ Pack-aware       │ │  ├─ ambiguous            │
│ testing          │ │  └─ context-dependent    │
│ Aligns with      │ │                          │
│ Epic 02 schemas  │ │ Optional context hints:  │
└────────┬─────────┘ │  conversation, file/     │
         │           │  project, pack context   │
         │           └────────────┬──────────────┘
         │                        │
         └────────┬───────────────┘
                  │
                  ▼
┌───────────────────────────────────────┐
│  05.4 Implement Trigger Simulation    │
│  Runner                               │
│                                       │
│  Input: candidate skill + roster +    │
│         trigger test case             │
│                                       │
│  ┌─────────────────────────────────┐  │
│  │  Anthropic API Call             │  │
│  │  (routing approximation prompt) │  │
│  └──────────────┬──────────────────┘  │
│                 │                      │
│                 ▼                      │
│  Classification:                      │
│   ├─ correct trigger                  │
│   ├─ false positive                   │
│   ├─ false negative                   │
│   ├─ sibling confusion               │
│   ├─ none selected                    │
│   └─ ambiguous multi-match            │
│                                       │
│  Captures raw prompt/response evidence│
└──────────────────┬────────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
┌──────────────────┐ ┌─────────────────────────┐
│ 05.5 Implement   │ │ 05.6 Implement Pack-    │
│ Trigger Metrics  │ │ Level Confusion &       │
│ & Classification │ │ Overlap Analysis        │
│                  │ │                          │
│ Per-skill:       │ │ Identify overlap pairs   │
│  precision       │ │ Detect activation        │
│  recall          │ │ stealing                 │
│  false-pos rate  │ │ Flag concerning overlap  │
│  false-neg rate  │ │ thresholds               │
│  ambiguity rate  │ │ Explicit output (not     │
│                  │ │ buried in logs)           │
│ Pack aggregation │ │                          │
└────────┬─────────┘ └────────────┬──────────────┘
         │                        │
         └────────┬───────────────┘
                  │
                  ▼
┌───────────────────────────────────────┐
│  05.7 Persist Trigger Evidence &      │
│  Retrieval-Ready Summaries            │
│                                       │
│  Store via Epic 04 evidence model     │
│  Raw evidence + summarized results    │
│  Retrieval helpers for trigger        │
│  outcomes and metrics                 │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  05.8 Document Approximation Limits   │
│  & Close                              │
│                                       │
│  Honest docs: this is routing         │
│  approximation, not exact Claude Code │
│  routing replication                  │
│  End-of-epic AAR produced             │
│  Carry-forward for Epics 07-09       │
└───────────────────────────────────────┘
```

## Outputs
- Available-skills roster builder
- Sibling-skill / pack context model
- Trigger simulation runner (first model-backed evaluation layer)
- Trigger result classification (correct, false-pos, false-neg, sibling confusion, none, ambiguous)
- Trigger metrics (precision, recall, false-positive rate, false-negative rate, ambiguity rate)
- Pack-level confusion / overlap analysis
- Persisted trigger evidence in canonical evidence system
- Carry-forward: trigger results and metrics for Epics 07, 08, 09

## Key Artifacts
- Roster builder module
- Sibling-skill context handler
- Trigger test case parser / categorizer
- Trigger simulation runner (Anthropic API integration)
- Trigger result classifier
- Trigger metrics calculator
- Pack confusion analyzer
- Persisted trigger run records + retrievable summaries
- Approximation-limits documentation
- Epic 05 AAR document
