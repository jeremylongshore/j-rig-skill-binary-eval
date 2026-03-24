# Epic 09 -- Optimizer and Experiment Engine

## Purpose

This epic builds the controlled optimization layer for J-Rig Binary Eval.

Its purpose is to take evaluation evidence, identify the most valuable improvement opportunities, propose exactly one interpretable change at a time, run that change through the full relevant evaluation flow, and keep or reject the change based on hard evidence.

A rollout gate without an improvement engine can tell you what is wrong, but not help you systematically fix it. Epic 09 exists to make J-Rig Binary Eval capable of safe, controlled iteration rather than manual guesswork.

This is the epic where the product becomes not just a gate, but a disciplined **improvement system**.

---

## Product Context

J-Rig Binary Eval is a Claude-native evaluation harness and rollout gate for Claude Skills.

The product must ultimately be able to answer:

- what is the weakest criterion or cluster of failures right now
- which failure is root cause versus symptom
- what single change is worth trying next
- what happened after that change
- did the change improve the right things
- did the change create regressions
- should the change be kept or reverted
- when should the optimizer stop trying
- when should a human take over because the problem is structural or resistant

Epic 09 creates the system that makes those answers operational.

This epic is not about wild autonomous rewriting. It is about **safe, interpretable, evidence-backed experimentation**.

---

## In Scope

This epic includes:

- failure clustering and prioritization
- weakest-criterion targeting
- structured single-change proposal generation
- experiment execution against relevant test suites
- accept/reject/revert logic
- early stopping behavior
- optimization-resistant case handling
- experiment evidence persistence and retrieval
- docs explaining optimization behavior and safety constraints
- producing an end-of-epic AAR

---

## Explicitly Out of Scope

This epic does **not** include:

- broad autonomous multi-change rewrites
- giant multi-agent orchestration for appearance's sake
- dashboard-heavy team product polish
- generalized prompt optimization beyond the Claude Skill scope
- final marketplace UI workflows
- human approval product surfaces beyond minimal hooks if needed

This epic is about **single-change safe optimization**, not autonomous chaos.

---

## Dependencies

### Depends on

- Epic 01 -- Repo Foundation and Operating Standard
- Epic 02 -- Spec Layer and Contract System
- Epic 03 -- Package Integrity and Deterministic Checks
- Epic 04 -- Evidence Layer, Persistence, and Run Lifecycle
- Epic 05 -- Trigger Harness and Skill Roster Simulation
- Epic 06 -- Functional Execution Harness and Observation Layer
- Epic 07 -- Judgment Layer, Calibration, and Model Matrix
- Epic 08 -- Regression, Baseline, Scoring, CLI, and CI Gate

### Blocks

This epic blocks:

- Epic 10 -- Team Product, Eval Packs, and Drift Operations

Epic 10 can still build some product surfaces without full optimization, but the full team/product story is much stronger once experiment history and optimizer evidence are real.

---

## Deliverables

By the end of Epic 09, the repo should have:

- a failure clustering and prioritization layer
- weakest-criterion targeting logic
- a structured one-change proposal engine
- an experiment runner using the existing evaluation harness
- accept/reject/revert logic
- early stopping behavior
- optimization-resistant case tagging/surfacing
- persisted experiment history
- docs explaining optimizer behavior and safety constraints
- an end-of-epic AAR with evidence

---

## Child Beads

### 09.1 -- Build failure clustering and prioritization

**Purpose**
Group related failures so the optimizer can reason about meaningful patterns instead of reacting to isolated noise.

**Acceptance**
- The system can group failures by criterion, test-case pattern, or related symptoms.
- The cluster output is structured and interpretable.
- Failure summaries distinguish likely root-cause clusters from scattered effects where possible.
- The output is suitable for use by later optimizer steps and visible evidence.

**Dependencies**
- Depends on: Epic 08 complete
- Blocks: 09.2, 09.3, 09.4

**Evidence**
- failure clustering implementation
- example cluster outputs
- tests or fixtures covering cluster behavior

---

### 09.2 -- Implement weakest-criterion and highest-value target selection

**Purpose**
Choose the next optimization target intentionally rather than guessing.

**Acceptance**
- The system can identify weak criteria or unstable/high-value failure clusters.
- Target selection logic is explicit and documented.
- The selection can consider:
  - failure rate
  - blocker importance
  - sacred regression sensitivity
  - pack-level risk
  - baseline value implications
- Output is persisted or otherwise retrievable.

**Dependencies**
- Depends on: 09.1
- Blocks: 09.3, 09.4, 09.5

**Evidence**
- target selection implementation
- example selected targets
- tests for prioritization behavior

---

### 09.3 -- Build the structured single-change proposal engine

**Purpose**
Generate exactly one interpretable candidate modification at a time so optimization remains attributable and reversible.

**Acceptance**
- The optimizer proposes exactly one change per experiment.
- Allowed change categories are explicit, such as:
  - add one instruction line
  - remove one instruction line
  - rewrite one instruction line
  - add one example
  - edit the description
  - add one banned pattern
  - add one required output field
  - narrow one trigger boundary
  - widen one under-trigger boundary
- Each proposal includes a hypothesis for why it should help.
- Proposed changes are represented in structured form.

**Dependencies**
- Depends on: 09.1, 09.2
- Blocks: 09.4, 09.5, 09.6

**Evidence**
- change proposal engine implementation
- example proposal objects
- tests ensuring single-change discipline

---

### 09.4 -- Build the experiment runner and candidate evaluation loop

**Purpose**
Run proposed changes through the existing harness so each optimization attempt becomes a real experiment rather than a suggestion.

**Acceptance**
- The system can apply a candidate change to a working copy or experiment context safely.
- The relevant evaluation suite can be executed against the candidate.
- Experiment runs are tied to the same evidence system as normal runs.
- Candidate experiment context is isolated enough to avoid contaminating baseline/source-of-truth artifacts unintentionally.

**Dependencies**
- Depends on: 09.2, 09.3
- Blocks: 09.5, 09.6, 09.7

**Evidence**
- experiment runner implementation
- example experiment run records
- tests for candidate execution lifecycle

---

### 09.5 -- Implement accept, reject, and revert logic

**Purpose**
Decide whether a proposed change should be kept, discarded, or explicitly reverted based on evidence.

**Acceptance**
- The system can accept a change only when relevant governance conditions are satisfied.
- The system can reject a change clearly when it fails to improve enough or creates harmful side effects.
- The system can revert changes when experiment outcomes are unsafe.
- Decision reasons are explicit and persisted.
- The logic respects:
  - blocker rules
  - sacred regression rules
  - pack-level regression rules
  - baseline value constraints

**Dependencies**
- Depends on: 09.4 and Epic 08 governance logic
- Blocks: 09.6, 09.7, 09.8

**Evidence**
- decision engine implementation
- accepted experiment example
- rejected/reverted experiment example
- tests for decision logic

---

### 09.6 -- Add early stopping behavior and resistance detection

**Purpose**
Prevent the optimizer from looping forever and surface cases where automated improvement is not the right tool.

**Acceptance**
- The system supports stopping after:
  - a target score is reached
  - minimum gain is not met repeatedly
  - repeated reverts occur on the same weak area
  - max iteration limits are hit
- Optimization-resistant cases are flagged explicitly.
- Resistance reasons are documented or categorized where possible.
- Stop conditions are configurable and test-covered.

**Dependencies**
- Depends on: 09.3, 09.4, 09.5
- Blocks: 09.7, 09.8, Epic 10

**Evidence**
- early stopping implementation
- resistance tagging implementation
- example stopped/resistant cases
- tests for stopping logic

---

### 09.7 -- Persist experiment history and optimization evidence

**Purpose**
Make optimizer behavior durable, inspectable, and reusable for later reporting and team workflows.

**Acceptance**
- Experiment proposals, runs, decisions, and reasons are persisted.
- It is possible to retrieve:
  - proposed change
  - hypothesis
  - before/after results
  - decision
  - revert/accept state
- Optimization evidence aligns with the canonical evidence model.
- Retrieval paths are documented.

**Dependencies**
- Depends on: 09.4, 09.5, 09.6
- Blocks: 09.8, Epic 10

**Evidence**
- persisted experiment records
- retrieval examples
- tests for experiment storage and retrieval

---

### 09.8 -- Document optimizer safety constraints, verify experiment flow, and close Epic 09 cleanly

**Purpose**
Close the epic with proof that J-Rig Binary Eval can improve skills in a controlled, safe, and explainable way.

**Acceptance**
- Optimizer flow is demonstrated end to end.
- At least one accepted experiment and one rejected/reverted experiment are shown.
- Docs explain optimizer limits and safety principles honestly.
- Beads statuses are accurate.
- End-of-epic AAR is created.
- Carry-forward notes for Epic 10 are written.

**Dependencies**
- Depends on: 09.5, 09.6, 09.7
- Blocks: Epic 10

**Evidence**
- experiment flow outputs
- accepted and rejected experiment examples
- docs path(s)
- AAR path
- carry-forward notes

---

## Technical Design Notes

### Single-change discipline is sacred

The optimizer must never become a sloppy rewrite bot.

One change at a time keeps:
- causality clear
- regression analysis meaningful
- revert logic possible
- evidence trustworthy

### Safe improvement beats flashy autonomy

The product should optimize for:
- interpretability
- reversibility
- evidence-backed decision-making

not:
- giant autonomous rewrites
- many changes at once
- theatrical "agentic" behavior that makes debugging impossible

### Experiments are first-class evidence

An experiment is not just an internal loop. It is a durable artifact with:
- proposal
- hypothesis
- run evidence
- before/after comparison
- keep/reject/revert decision

That must be stored and queryable.

### Stopping is a feature

An optimizer that cannot stop is not a product advantage. It is a liability with good marketing.

Resistance detection and early stopping are first-class safety features.

---

## Validation and Acceptance Gates

Epic 09 is only complete if all of the following are true:

- failure clustering exists
- target selection exists
- only one change is proposed per experiment
- experiment runs execute through the real harness
- accept/reject/revert logic works
- early stopping works
- resistant cases are surfaced
- experiment history is persisted and retrievable
- docs explain optimizer behavior honestly
- the repo is genuinely ready for team-facing reporting and drift operations

---

## Evidence Required for Closeout

At closeout, capture:

- clustering/prioritization paths
- proposal engine paths
- experiment runner paths
- accept/reject/revert paths
- early stopping/resistance paths
- persisted experiment examples
- retrieval examples
- sample accepted experiment
- sample rejected/reverted experiment
- test outputs
- docs path(s)
- Epic 09 AAR path
- explicit carry-forward notes for Epic 10

---

## Risks and Edge Cases

### Optimizer starts gaming the judge
If the system learns to please evaluator quirks rather than improve real outcomes, trust drops fast.

### Multi-change creep
If "just one more little change" sneaks in, the whole causality model weakens.

### Revert logic is weak or incomplete
A product that can try experiments but not back out safely is a production hazard.

### Early stopping is too timid or too loose
Overly aggressive stopping kills useful improvements. Weak stopping creates endless churn.

### Experiment evidence is too thin
If history does not clearly show what changed and why, later team product surfaces will feel hollow.

---

## Claude Code Execution Notes

When Claude Code works this epic, it should:

- verify Epics 01-08 landed correctly before starting
- inspect any existing optimization or experiment code before adding new work
- preserve single-change discipline strictly
- build the optimizer as a controlled evidence loop, not an autonomous rewrite circus
- make acceptance/rejection reasons explicit
- treat revert logic as critical
- surface resistant cases honestly
- persist experiment history cleanly
- produce a durable end-of-epic AAR

### Mandatory workflow reminders
- verify prior epic first
- check comments/fixes if this is a follow-up pass
- run a repo sweep when relevant
- do not overbuild multi-agent complexity here
- do not allow "close enough" experiment reasoning to bypass blocker/sacred regression rules

---

## Suggested Branch / Commit / PR Discipline

### Branch
`feature/epic-09-optimizer-and-experiment-engine`

### Commit style
- `feat(epic-09): add failure clustering and target selection`
- `feat(epic-09): add structured single-change proposal engine`
- `feat(epic-09): add experiment runner`
- `feat(epic-09): add accept reject revert logic`
- `feat(epic-09): add early stopping and resistance handling`
- `feat(epic-09): persist experiment history and retrieval`
- `test(epic-09): add optimizer and experiment coverage`
- `docs(epic-09): document optimizer behavior and limits`
- `docs(epic-09): add epic 09 aar`

### PR title
`[EPIC 09] Optimizer and experiment engine`

---

## AAR Requirements

The Epic 09 AAR must include:

### What shipped
- clustering and prioritization completed
- proposal engine completed
- experiment runner completed
- accept/reject/revert logic completed
- early stopping completed
- resistance handling completed
- experiment history completed
- docs and tests completed

### Evidence
- sample target selection
- sample change proposal
- sample accepted experiment
- sample rejected/reverted experiment
- sample resistance case
- docs paths
- test outputs

### Open risks
- any optimizer bias still visible
- any thin spots in revert safety
- any experiment isolation concerns later team product work must keep in mind

### What Epic 10 inherits
- experiment history now considered canonical
- optimizer outputs available for dashboard/reporting surfaces
- resistant-case signals available for team workflows
- any operational constraints drift/scheduled reevaluation must respect

---

## Reference Note for Beads

Every Epic 09 bead should reference this file.

Suggested annotation line:

`Reference doc: 000-docs/epics/epic-09-optimizer-and-experiment-engine.md`

Suggested instruction line:

`This task is governed by the epic reference doc above. Follow its scope, dependencies, acceptance gates, evidence requirements, and out-of-scope constraints.`
