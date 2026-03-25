# Epic 09 — Optimizer and Experiment Engine — Workflow

## Inputs
- Eval spec / contract schemas from Epic 02
- Full evaluation harness (Epics 03-07)
- Evidence model and persistence from Epic 04
- Trigger metrics, observed outcomes, and criterion judgments from Epics 05-07
- Regression comparison engine from Epic 08
- Sacred regression / blocker rules from Epic 08
- Baseline comparison from Epic 08
- Recommendation outcomes (pass/warn/block) from Epic 08

## Flow

```
┌───────────────────────────────────────┐
│  09.1 Failure Clustering &            │
│  Prioritization                       │
│                                       │
│  Group failures by:                   │
│   criterion, test-case pattern,       │
│   related symptoms                    │
│  Distinguish root-cause clusters      │
│  from scattered effects               │
│  Structured, interpretable output     │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  09.2 Weakest-Criterion & Highest-    │
│  Value Target Selection               │
│                                       │
│  Rank targets by:                     │
│   failure rate                        │
│   blocker importance                  │
│   sacred regression sensitivity       │
│   pack-level risk                     │
│   baseline value implications         │
│                                       │
│  Select single highest-value target   │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  09.3 Structured Single-Change        │
│  Proposal Engine                      │
│                                       │
│  Exactly ONE change per experiment:   │
│   ├─ add one instruction line         │
│   ├─ remove one instruction line      │
│   ├─ rewrite one instruction line     │
│   ├─ add one example                  │
│   ├─ edit the description             │
│   ├─ add one banned pattern           │
│   ├─ add one required output field    │
│   ├─ narrow one trigger boundary      │
│   └─ widen one under-trigger boundary │
│                                       │
│  Includes hypothesis for why it helps │
│  Represented in structured form       │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  09.4 Experiment Runner &             │
│  Candidate Evaluation Loop            │
│                                       │
│  Apply candidate change to working    │
│  copy (isolated from source-of-truth) │
│           │                           │
│           ▼                           │
│  ┌─────────────────────────────────┐  │
│  │ Run relevant eval suite through │  │
│  │ existing harness (Epics 03-07)  │  │
│  │                                 │  │
│  │ Package checks ► Trigger sim    │  │
│  │ ► Functional exec ► Judgment    │  │
│  └──────────────┬──────────────────┘  │
│                 │                      │
│  Experiment runs tied to canonical    │
│  evidence system                      │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  09.5 Accept / Reject / Revert Logic  │
│                                       │
│  ◇ Blocker rules still pass?         │
│  ├─NO──► REJECT / REVERT             │
│  │                                    │
│  ◇ Sacred regressions intact?        │
│  ├─NO──► REJECT / REVERT             │
│  │                                    │
│  ◇ Pack-level regressions?           │
│  ├─YES─► REJECT / REVERT             │
│  │                                    │
│  ◇ Baseline value maintained?        │
│  ├─NO──► REJECT / REVERT             │
│  │                                    │
│  ◇ Net improvement sufficient?       │
│  ├─YES─► ACCEPT                       │
│  └─NO──► REJECT                       │
│                                       │
│  Decision reasons explicit & persisted│
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  09.6 Early Stopping &                │
│  Resistance Detection                 │
│                                       │
│  Stop conditions:                     │
│   ◇ Target score reached?  ► STOP    │
│   ◇ Min gain not met x N?  ► STOP   │
│   ◇ Repeated reverts on    ► FLAG    │
│     same weak area?          RESISTANT│
│   ◇ Max iterations hit?    ► STOP    │
│                                       │
│  Resistant cases flagged for human    │
│  review                               │
│  Resistance reasons categorized       │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  09.7 Persist Experiment History &    │
│  Optimization Evidence                │
│                                       │
│  Per experiment stored:               │
│   proposed change + hypothesis        │
│   before/after results                │
│   accept / reject / revert decision   │
│   resistance flags                    │
│                                       │
│  Queryable via canonical evidence     │
│  model                                │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  09.8 Document Optimizer Safety       │
│  Constraints & Close                  │
│                                       │
│  End-to-end optimizer flow demoed     │
│  Accepted + rejected experiments      │
│  shown                                │
│  Safety principles documented         │
│  End-of-epic AAR produced             │
│  Carry-forward for Epic 10           │
└───────────────────────────────────────┘
```

## Outputs
- Failure clustering and prioritization
- Weakest-criterion / highest-value target selection
- Single-change proposal engine (strict one-change discipline)
- Experiment runner using full evaluation harness
- Accept / reject / revert decision engine
- Early stopping and optimization-resistance detection
- Persisted experiment history (proposals, hypotheses, before/after, decisions)
- Carry-forward: experiment history and optimizer evidence for Epic 10 team surfaces

## Key Artifacts
- Failure cluster module
- Target selection / prioritization module
- Single-change proposal engine (structured change categories)
- Experiment runner (isolated candidate evaluation loop)
- Accept / reject / revert decision engine
- Early stopping controller
- Resistance detector and flagger
- Persisted experiment records (proposal, hypothesis, results, decision, revert-state)
- Optimizer safety documentation
- Epic 09 AAR document
