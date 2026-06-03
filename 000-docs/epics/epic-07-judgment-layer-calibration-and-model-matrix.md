# Epic 07 -- Judgment Layer, Calibration, and Model Matrix

## Purpose

This epic builds the external judgment system for J-Rig Binary Eval.

Its purpose is to take the observed outcomes produced by earlier epics and convert them into disciplined, machine-readable evaluation results using deterministic checks where possible and external LLM judges where needed. This epic also establishes calibration, disagreement handling, and per-model execution awareness so the product does not pretend one model, one prompt, or one judge phrasing is universal truth.

A harness that can execute skills but cannot evaluate them consistently is still incomplete. Epic 07 exists to make the evaluation layer real.

This is the epic where J-Rig Binary Eval begins turning observed behavior into explicit **yes / no / unsure** judgments that can later drive release gating, regression detection, and optimization.

---

## Product Context

J-Rig Binary Eval is a Claude-native evaluation harness and rollout gate for Claude Skills.

The product must ultimately be able to answer:

- did this observed outcome satisfy the criterion
- is the result clearly pass, clearly fail, or genuinely unclear
- can deterministic checks catch this cheaply
- when semantic interpretation is needed, can an external evaluator judge it strictly
- is the evaluator itself behaving consistently
- do different Claude models produce materially different evaluation outcomes
- are some results stable while others need disagreement handling or human review
- can later phases trust this judgment layer enough to gate releases

Epic 07 creates the controlled evaluation layer that makes those answers possible.

This epic is about **judgment quality and evaluator discipline**, not final release policy.

---

## In Scope

This epic includes:

- implementing the binary judge engine
- enforcing strict machine-readable judge outputs
- integrating deterministic-first judgment flow
- implementing judge prompt templates and phrasing rotation
- implementing calibration/golden-case validation
- implementing disagreement and unsure handling
- implementing per-model execution matrix support for judgment flows
- persisting judgment evidence and model-specific judgment results
- documenting judge assumptions and calibration expectations
- producing an end-of-epic AAR

---

## Explicitly Out of Scope

This epic does **not** include:

- final launch recommendation policy
- regression gating policy
- baseline/no-skill release policy
- optimizer experiment logic
- dashboard UI
- broad human-review workflow beyond minimal escalation/support hooks
- fully generalized cross-ecosystem model support outside the Claude-centric scope

This epic is about **converting observed outcomes into disciplined judgments**, not full product governance.

---

## Dependencies

### Depends on

- Epic 01 -- Repo Foundation and Operating Standard
- Epic 02 -- Spec Layer and Contract System
- Epic 03 -- Package Integrity and Deterministic Checks
- Epic 04 -- Evidence Layer, Persistence, and Run Lifecycle
- Epic 05 -- Trigger Harness and Skill Roster Simulation
- Epic 06 -- Functional Execution Harness and Observation Layer

### Blocks

This epic blocks:

- Epic 08 -- Regression, Baseline, Scoring, CLI, and CI Gate
- Epic 09 -- Optimizer and Experiment Engine
- Epic 10 -- Team Product, Eval Packs, and Drift Operations

Those later layers need reliable criterion-level judgments and per-model evidence.

---

## Deliverables

By the end of Epic 07, the repo should have:

- a binary judge engine
- strict parsing/validation of judge outputs
- deterministic-first judgment flow
- judge prompt templates and phrasing rotation
- calibration/golden-case checks
- disagreement and unsure handling
- model-aware judgment execution support
- persisted judgment evidence using the canonical evidence model
- docs describing judgment behavior and calibration limits
- an end-of-epic AAR with evidence

---

## Child Beads

### 07.1 -- Build the binary judge engine

**Purpose**
Create the core judgment component that evaluates observed outcomes against criteria and returns only structured pass/fail/uncertain-style results.

#### Acceptance

- The judge can evaluate an observed outcome against a criterion.
- Supported result space is explicitly constrained to:
  - yes
  - no
  - unsure
- The judge emits short evidence or rationale fields suitable for traceability.
- The engine is reusable across trigger, functional, and future baseline judgments.

#### Dependencies

- Depends on: Epics 02, 05, and 06 complete
- Blocks: 07.2, 07.3, 07.4, 07.5

#### Evidence

- judge engine implementation
- example judgments
- tests for basic judgment flow

---

### 07.2 -- Enforce strict machine-readable parsing and schema validation for judge outputs

**Purpose**
Prevent evaluator slop, malformed outputs, or hallucinated extra structure from silently entering the system.

#### Acceptance

- Judge outputs are validated against a strict schema.
- Invalid judge outputs fail clearly and are represented explicitly.
- Parsing logic does not silently coerce malformed output into success.
- The validation layer is reusable and documented.

#### Dependencies

- Depends on: 07.1
- Blocks: 07.3, 07.4, 07.5, 07.6

#### Evidence

- parsing/validation implementation
- malformed-output test coverage
- example invalid-output failure cases

---

### 07.3 -- Implement deterministic-first judgment flow

**Purpose**
Ensure the system always prefers cheap, explicit checks before resorting to semantic judge calls.

#### Acceptance

- Deterministic checks from Epic 03 are used first where applicable.
- The system only escalates to LLM-based judgment when deterministic checks do not fully resolve the criterion.
- Routing between deterministic and judge-based paths is explicit and documented.
- Result objects indicate how the judgment was reached.

#### Dependencies

- Depends on: 07.1, 07.2
- Blocks: 07.4, 07.5, 07.6, Epic 08

#### Evidence

- deterministic-first routing implementation
- examples of deterministic resolution vs judge escalation
- tests for mixed judgment flows

---

### 07.4 -- Add judge prompt templates and phrasing rotation

**Purpose**
Reduce the chance that the system overfits to one evaluator wording and becomes easy to game or accidentally biased.

#### Acceptance

- The system supports multiple phrased variants for a criterion/judge prompt.
- Prompt templates are organized and maintainable.
- Rotation or alternate phrasing behavior is explicit.
- Documentation explains why prompt variation exists and how it is applied.

#### Dependencies

- Depends on: 07.1, 07.2
- Blocks: 07.5, 07.6, Epic 09

#### Evidence

- prompt template files
- example rotated judgment runs
- tests or fixtures validating prompt-path behavior

---

### 07.5 -- Implement calibration and golden-case validation

**Purpose**
Verify that the judgment layer itself remains trustworthy rather than assuming evaluator output is always correct.

#### Acceptance

- A calibration/golden-case workflow exists.
- Known-good judgment examples can be run before or during important evaluation flows.
- Calibration failure is surfaced clearly.
- Calibration metadata is stored and retrievable.
- The docs explain how calibration is expected to be used.

#### Dependencies

- Depends on: 07.2, 07.3, 07.4
- Blocks: 07.6, 07.7, Epic 08, Epic 09

#### Evidence

- calibration workflow implementation
- golden-case fixtures
- example calibration runs
- tests for pass/fail calibration scenarios

---

### 07.6 -- Implement disagreement and unsure handling

**Purpose**
Represent evaluator uncertainty honestly instead of forcing false confidence.

#### Acceptance

- The system supports "unsure" as a real outcome, not a bug.
- Disagreement between deterministic and LLM judgment, or between multiple judge variants where supported, is represented clearly.
- Unclear results are stored in a structured way for later policy handling.
- The docs explain when and why unsure/disagreement states can happen.

#### Dependencies

- Depends on: 07.2, 07.4, 07.5
- Blocks: 07.7, Epic 08, Epic 09

#### Evidence

- unsure/disagreement handling implementation
- example disagreement cases
- tests for disagreement state persistence and retrieval

---

### 07.7 -- Implement per-model judgment matrix support

**Purpose**
Support evaluation runs across multiple Claude models so J-Rig Binary Eval can measure model-aware judgment behavior rather than assuming one model fits all cases.

#### Acceptance

- Judgment flows can be run against configured Claude models where applicable.
- Results are stored with model identity and associated metadata.
- The system can produce per-model judgment summaries or comparisons.
- Model-specific differences are retrievable and documented.
- The design aligns with future model-matrix reporting and rollout decisions.

#### Dependencies

- Depends on: 07.3, 07.5, 07.6
- Blocks: 07.8, Epic 08, Epic 10

#### Evidence

- model-matrix execution support
- example per-model judgment outputs
- tests or fixtures showing model-tagged persistence

---

### 07.8 -- Persist judgment evidence, document calibration limits, and close Epic 07 cleanly

**Purpose**
Close the epic with proof that the system can convert observed outcomes into disciplined judgments and record the results durably.

#### Acceptance

- Judgments are persisted in the canonical evidence model.
- Deterministic, judge-based, unsure, disagreement, and calibration-aware outcomes are all represented as appropriate.
- Docs explain judgment flow, calibration expectations, and model-matrix behavior honestly.
- Beads statuses are accurate.
- End-of-epic AAR is created.
- Carry-forward notes for Epics 08-10 are written.

#### Dependencies

- Depends on: 07.5, 07.6, 07.7
- Blocks: Epic 08

#### Evidence

- persisted judgment examples
- calibration example output
- per-model judgment example
- docs path(s)
- AAR path
- carry-forward notes

---

## Technical Design Notes

### External evaluator is non-negotiable

The skill under test must never be the final judge of itself.

This epic operationalizes that rule by ensuring:

- deterministic checks are explicit
- semantic evaluation is externalized
- outputs are machine-validated
- uncertainty is represented honestly

### Yes / no / unsure is a feature, not a limitation

The judgment system should resist the temptation to become verbose, fuzzy, or over-explanatory.

The point is not to generate long prose.
The point is to make evaluation **usable** in later automation and governance.

### Deterministic first, evaluator second

Deterministic checks should act as the cheap front gate.
External judging should only be invoked when semantics truly require it.

This keeps:

- cost lower
- behavior clearer
- results more reproducible

### Calibration protects trust

A judge that cannot be calibrated is a risk.

This epic should establish calibration/golden-case workflows as normal product behavior, not optional research extras.

### Model-aware judgment is required

Different Claude models may judge differently.
That difference is not noise to be hidden; it is product reality to be measured.

---

## Validation and Acceptance Gates

Epic 07 is only complete if all of the following are true:

- the binary judge engine works
- judge outputs are strictly parsed and validated
- deterministic-first routing exists
- prompt templates/rotation exist
- calibration/golden-case flow exists
- unsure/disagreement states are represented clearly
- per-model judgment support exists
- judgment evidence is persisted and retrievable
- docs explain judgment assumptions honestly
- the repo is genuinely ready for regression, baseline, scoring, and governance work

---

## Evidence Required for Closeout

At closeout, capture:

- judge engine paths
- strict validation paths
- deterministic-first routing paths
- prompt template paths
- calibration fixture paths
- disagreement-handling paths
- model-matrix paths
- persisted judgment example(s)
- calibration example(s)
- per-model judgment example(s)
- test outputs
- docs path(s)
- Epic 07 AAR path
- explicit carry-forward notes for Epic 08, Epic 09, and Epic 10

---

## Risks and Edge Cases

### Evaluator slop leaks into core logic

If malformed judge output is accepted, later release gating will be untrustworthy.

### Forced certainty

If the system cannot represent "unsure," it will invent false confidence where ambiguity is real.

### Deterministic path gets bypassed too easily

That would make the system more expensive and less interpretable than it needs to be.

### Calibration becomes ceremonial

If calibration exists only on paper, the judgment layer will drift without warning.

### Model differences are ignored

If per-model divergence is hidden, later rollout guidance will be weaker than it should be.

---

## Claude Code Execution Notes

When Claude Code works this epic, it should:

- verify Epics 01-06 landed correctly before starting
- inspect any existing judgment/calibration code before creating new work
- preserve the external evaluator rule
- implement strict machine-readable output validation
- treat unsure/disagreement as first-class outcomes
- keep deterministic-first routing clear and testable
- build calibration/golden-case flow as a real mechanism, not a note
- persist judgment evidence cleanly
- produce a durable end-of-epic AAR

### Mandatory workflow reminders

- verify prior epic first
- check comments/fixes if this is a follow-up pass
- run a repo sweep when relevant
- do not jump into release scoring or optimizer policy here
- do not allow essay-like evaluator outputs to become the system norm

---

## Suggested Branch / Commit / PR Discipline

### Branch

`feature/epic-07-judgment-layer-calibration-and-model-matrix`

### Commit style

- `feat(epic-07): add binary judge engine`
- `feat(epic-07): add strict judge output validation`
- `feat(epic-07): add deterministic-first judgment routing`
- `feat(epic-07): add judge prompt templates and rotation`
- `feat(epic-07): add calibration and golden-case workflow`
- `feat(epic-07): add disagreement and unsure handling`
- `feat(epic-07): add per-model judgment matrix support`
- `test(epic-07): add judgment, calibration, and disagreement coverage`
- `docs(epic-07): document judgment layer and calibration behavior`
- `docs(epic-07): add epic 07 aar`

### PR title

`[EPIC 07] Judgment layer, calibration, and model matrix`

---

## AAR Requirements

The Epic 07 AAR must include:

### What shipped

- binary judge engine completed
- strict validation completed
- deterministic-first flow completed
- prompt rotation completed
- calibration workflow completed
- unsure/disagreement handling completed
- per-model support completed
- docs and tests completed

### Evidence

- sample deterministic judgment
- sample judge-based semantic judgment
- sample malformed-output rejection
- sample unsure/disagreement case
- sample calibration run
- sample per-model judgment output
- docs paths
- test outputs

### Open risks

- any calibration weaknesses still present
- any model-specific judgment quirks discovered
- any remaining ambiguity around unsure-handling that later policy must account for

### What later epics inherit

- criterion-level judgment records now considered canonical
- calibration metadata later release governance must respect
- disagreement states later scoring/gating must handle explicitly
- model-tagged judgment evidence later reporting and optimization must preserve

---

## Reference Note for Beads

Every Epic 07 bead should reference this file.

Suggested annotation line:

`Reference doc: 000-docs/epics/epic-07-judgment-layer-calibration-and-model-matrix.md`

Suggested instruction line:

`This task is governed by the epic reference doc above. Follow its scope, dependencies, acceptance gates, evidence requirements, and out-of-scope constraints.`
