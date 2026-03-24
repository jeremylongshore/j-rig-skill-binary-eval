# Epic 05 -- Trigger Harness and Skill Roster Simulation

## Purpose

This epic builds the trigger evaluation system for J-Rig Binary Eval.

Its purpose is to determine whether a Claude Skill would likely be selected when it should be, avoided when it should not be, and differentiated correctly from sibling skills in the same pack or library. This epic creates the first model-backed behavioral evaluation layer in the product.

A skill can have perfect package integrity and clean deterministic checks while still being operationally broken if it triggers on the wrong requests, fails to trigger on obvious requests, or collides with sibling skills. Epic 05 exists to measure and surface that behavior.

This is the epic where J-Rig Binary Eval begins evaluating **routing behavior**, not just package quality.

---

## Product Context

J-Rig Binary Eval is a Claude-native evaluation harness and rollout gate for Claude Skills.

The product must be able to answer:

- does this skill trigger on clear, intended requests
- does this skill avoid triggering on unrelated requests
- what happens on paraphrases and fuzzy-but-valid requests
- what happens on ambiguous cases
- how often does this skill collide with sibling skills
- is pack-level overlap becoming a rollout risk
- did a change improve recall at the cost of precision
- is skill routing still acceptable across likely model/runtime contexts

Epic 05 is the first step toward answering those questions systematically.

This epic does **not** claim to perfectly reproduce Claude Code internals. Its purpose is to build a strong, honest approximation that is good enough for:

- relative comparison
- release gating
- sibling confusion analysis
- regression tracking
- future pack-aware optimization

---

## In Scope

This epic includes:

- building the available-skills roster simulation
- defining sibling-skill context handling
- defining trigger test case types and formats
- implementing the trigger simulation runner
- implementing trigger result classification
- implementing trigger precision/recall/confusion metrics
- implementing pack-level overlap/confusion analysis
- persisting trigger evidence using the Epic 04 evidence model
- documenting approximation limits and trigger-eval assumptions
- producing an end-of-epic AAR

---

## Explicitly Out of Scope

This epic does **not** include:

- full functional execution of skills after selection
- artifact generation or observation
- LLM judge grading of skill outputs
- model matrix and calibration layer
- baseline/no-skill comparison
- release scoring and pass/warn/block logic
- optimizer logic
- dashboard implementation

This epic is about **skill selection and routing behavior**, not full execution quality.

---

## Dependencies

### Depends on

- Epic 01 -- Repo Foundation and Operating Standard
- Epic 02 -- Spec Layer and Contract System
- Epic 03 -- Package Integrity and Deterministic Checks
- Epic 04 -- Evidence Layer, Persistence, and Run Lifecycle

### Blocks

This epic blocks:

- Epic 07 -- Judgment Layer, Calibration, and Model Matrix
- Epic 08 -- Regression, Baseline, Scoring, CLI, and CI Gate
- Epic 09 -- Optimizer and Experiment Engine
- Epic 10 -- Team Product, Eval Packs, and Drift Operations

Epic 06 can proceed in parallel conceptually, but Epic 08 and later governance/optimization layers require real trigger evidence and trigger metrics.

---

## Deliverables

By the end of Epic 05, the repo should have:

- an available-skills roster builder
- a sibling-skill context model
- trigger test case support for positive, negative, ambiguous, and context-dependent prompts
- a trigger simulation runner
- trigger result classification logic
- trigger metrics computation
- pack-level confusion/overlap analysis
- stored trigger evidence in the canonical evidence model
- docs explaining how trigger simulation works and where it is approximate
- an end-of-epic AAR with evidence

---

## Child Beads

### 05.1 -- Build the available-skills roster builder

**Purpose**
Construct the simulated skill roster that the trigger harness will present to the evaluator when deciding which skill should activate.

**Acceptance**
- The system can build an available-skills representation from one target skill plus optional sibling skills.
- The roster builder uses canonical parsed skill metadata rather than ad hoc string assembly.
- The representation is stable and reusable across trigger tests.
- The formatting is documented well enough that later debugging is possible.

**Dependencies**
- Depends on: Epics 02 and 04 complete
- Blocks: 05.2, 05.3, 05.4, 05.5

**Evidence**
- roster builder implementation
- example roster outputs
- tests covering single-skill and multi-skill rosters

---

### 05.2 -- Define sibling-skill and pack context handling

**Purpose**
Model the context needed to evaluate trigger behavior honestly when multiple related skills exist together.

**Acceptance**
- The harness can include sibling skills from spec/context definitions.
- Pack-aware testing is supported without requiring everything to run in isolation.
- Missing or malformed sibling references fail clearly.
- The pack context model is documented and aligns with Epic 02 schemas.

**Dependencies**
- Depends on: 05.1
- Blocks: 05.4, 05.5, 05.6

**Evidence**
- sibling context implementation
- fixtures/examples with multiple skills
- tests for valid and invalid sibling configurations

---

### 05.3 -- Define trigger test case formats and categories

**Purpose**
Create a robust structure for expressing the different kinds of trigger cases the system must evaluate.

**Acceptance**
- Trigger cases support at least:
  - should-trigger
  - should-not-trigger
  - ambiguous
  - context-dependent
- Test cases can include optional context hints such as:
  - prior conversation snippets
  - file/project hints
  - pack context
- Trigger expectations are explicit and machine-readable.
- The format is documented and fixture-backed.

**Dependencies**
- Depends on: Epic 02 complete
- Blocks: 05.4, 05.5, 05.6

**Evidence**
- trigger test case schema usage examples
- valid/invalid fixtures
- tests for parsing and categorization

---

### 05.4 -- Implement the trigger simulation runner

**Purpose**
Run the actual routing approximation that asks which skill would likely activate for a given user request and available-skills roster.

**Acceptance**
- The runner can execute trigger cases using the candidate skill plus context/siblings.
- It can classify responses as:
  - correct trigger
  - false positive
  - false negative
  - sibling confusion
  - none selected
  - ambiguous multi-match if intentionally supported
- The runner captures raw prompt/response evidence cleanly.
- Failures and API issues are surfaced in structured form.

**Dependencies**
- Depends on: 05.1, 05.2, 05.3
- Blocks: 05.5, 05.6, 05.7

**Evidence**
- trigger runner implementation
- sample executed trigger runs
- stored raw evidence examples
- tests for classification behavior

---

### 05.5 -- Implement trigger metrics and result classification

**Purpose**
Turn raw trigger outcomes into real metrics that can be used later for governance and comparison.

**Acceptance**
- The system computes at least:
  - trigger precision
  - trigger recall
  - false-positive rate
  - false-negative rate
  - ambiguity count or rate where applicable
- Metrics are computed per skill and can be aggregated for packs.
- Result classification is stable and documented.
- Metric output is compatible with future scoring/reporting work.

**Dependencies**
- Depends on: 05.4
- Blocks: 05.6, 05.7, Epic 08

**Evidence**
- metric computation implementation
- example per-skill metric outputs
- tests covering classification-to-metric translation

---

### 05.6 -- Implement pack-level confusion and overlap analysis

**Purpose**
Detect when related skills are colliding in ways that make rollout unsafe or low quality.

**Acceptance**
- The system can identify likely overlap/confusion pairs among sibling skills.
- Pack-level confusion output is explicit, not buried in raw logs.
- It is possible to see when one skill is stealing activations from another.
- Thresholds or flags for concerning overlap are documented, even if final gating policy comes later.

**Dependencies**
- Depends on: 05.2, 05.4, 05.5
- Blocks: 05.7, Epic 08, Epic 09

**Evidence**
- confusion analysis implementation
- example outputs for overlapping skills
- tests or fixtures that demonstrate confusion detection

---

### 05.7 -- Persist trigger evidence and retrieval-ready summaries

**Purpose**
Store trigger-run evidence in the canonical evidence system so later compare, scoring, and optimization layers can consume it.

**Acceptance**
- Trigger runs are persisted using the Epic 04 evidence model.
- Raw evidence and summarized results are both stored appropriately.
- Retrieval helpers can access trigger outcomes and metrics cleanly.
- The storage shape is documented for future users.

**Dependencies**
- Depends on: 05.4, 05.5, 05.6
- Blocks: 05.8, Epic 08, Epic 09, Epic 10

**Evidence**
- persisted trigger run examples
- retrieval examples
- tests for storage/readback of trigger evidence

---

### 05.8 -- Document approximation limits, verify trigger evaluation, and close Epic 05 cleanly

**Purpose**
Close the epic with proof that trigger evaluation is real, useful, and honestly documented.

**Acceptance**
- Trigger tests run on realistic sample skills.
- Positive, negative, ambiguous, and sibling-confusion cases are demonstrated.
- Docs explain how the harness approximates routing and where it may differ from real Claude Code behavior.
- Beads statuses are accurate.
- End-of-epic AAR is created.
- Carry-forward notes for Epics 07-09 are written.

**Dependencies**
- Depends on: 05.5, 05.6, 05.7
- Blocks: Epic 06 conceptually adjacent, Epic 08 directly

**Evidence**
- trigger run outputs
- confusion analysis outputs
- docs path(s)
- AAR path
- carry-forward notes

---

## Technical Design Notes

### Approximation, not false certainty

The trigger harness must be honest about what it is doing.

J-Rig Binary Eval is not reproducing the exact internal forward-pass routing behavior of Claude Code. It is constructing a controlled approximation using:

- parsed skill metadata
- available-skills roster construction
- explicit user test prompts
- optional sibling and context information
- evaluator/routing prompts

This is acceptable if the system is honest and consistent.

The goal is not mystical perfect emulation.
The goal is strong relative comparison and actionable release evidence.

### Trigger evaluation is about both recall and restraint

A skill that triggers on everything is not "working."

This epic must preserve the idea that trigger quality is made of both:
- positive activation
- non-activation restraint

That means negative and ambiguous cases are first-class, not optional extras.

### Pack-level evaluation matters

Some trigger issues only appear when multiple skills coexist.

This epic should treat sibling confusion and overlap as real product behavior, not a weird edge case.

### Structured evidence matters

Trigger runs should not disappear into prompt logs. The runner should produce:

- raw evidence
- classified outcomes
- metric summaries
- retrievable run records

That is what later governance and optimization layers depend on.

---

## Validation and Acceptance Gates

Epic 05 is only complete if all of the following are true:

- the available-skills roster builder works
- sibling/pack context is supported
- trigger test cases support positive, negative, ambiguous, and context-dependent cases
- the trigger runner executes and classifies outcomes
- precision/recall and related metrics are computed
- pack-level confusion analysis exists
- trigger evidence is persisted and retrievable
- docs explain both usage and approximation limits honestly
- the repo is genuinely ready for functional execution and later release-governance work

---

## Evidence Required for Closeout

At closeout, capture:

- trigger runner paths
- roster builder paths
- sibling context model paths
- metric/confusion analysis paths
- persisted trigger run example(s)
- retrieval/readback example(s)
- test outputs
- docs path(s)
- Epic 05 AAR path
- explicit carry-forward notes for Epic 06, Epic 07, Epic 08, and Epic 09

---

## Risks and Edge Cases

### Overclaiming fidelity to Claude Code routing
If the docs imply this is a perfect replica of real routing, trust will drop later.

### Isolation-only evaluation
Testing a skill alone can overestimate trigger quality badly. Pack-aware cases must be real.

### Weak negative case coverage
If the system mostly tests should-trigger prompts, trigger quality metrics will be misleading.

### Ambiguous-case handling gets ignored
Some of the most useful trigger intelligence comes from gray-area prompts. Those cannot be treated as noise.

### Raw outputs without useful classification
If the system stores only prompt/response blobs and not structured classification, later compare and scoring logic will inherit cleanup pain.

---

## Claude Code Execution Notes

When Claude Code works this epic, it should:

- verify Epics 01-04 landed correctly before starting
- inspect any existing trigger-related work before creating new work
- reuse canonical schemas and evidence models
- be explicit about routing approximation limits
- treat negative and ambiguous cases as first-class
- build pack-aware sibling confusion analysis, not just single-skill testing
- persist trigger evidence properly
- capture evidence during execution
- produce a durable end-of-epic AAR

### Mandatory workflow reminders
- verify prior epic first
- check comments/fixes if this is a follow-up pass
- run a repo sweep when relevant
- do not jump into full functional execution or judge scoring
- do not use vague trigger "success" language without precision/recall context

---

## Suggested Branch / Commit / PR Discipline

### Branch
`feature/epic-05-trigger-harness-and-skill-roster-simulation`

### Commit style
- `feat(epic-05): add available skills roster builder`
- `feat(epic-05): add sibling context and trigger case handling`
- `feat(epic-05): add trigger simulation runner`
- `feat(epic-05): add trigger metrics and classification`
- `feat(epic-05): add pack confusion and overlap analysis`
- `feat(epic-05): persist trigger evidence and summaries`
- `test(epic-05): add trigger fixtures and coverage`
- `docs(epic-05): document trigger harness behavior and limits`
- `docs(epic-05): add epic 05 aar`

### PR title
`[EPIC 05] Trigger harness and skill roster simulation`

---

## AAR Requirements

The Epic 05 AAR must include:

### What shipped
- roster builder completed
- sibling context handling completed
- trigger runner completed
- metrics and confusion analysis completed
- evidence persistence completed
- docs and tests completed

### Evidence
- sample positive trigger run
- sample negative trigger run
- sample ambiguous/confusion case
- persisted trigger evidence example
- test outputs
- docs paths

### Open risks
- any known approximation limitations
- any trigger cases still weakly covered
- any pack-confusion scenarios deferred or simplified

### What later epics inherit
- trigger result shapes now considered canonical
- confusion analysis outputs future scoring must respect
- retrieval conventions later compare/optimizer work must use
- any assumptions that functional execution or judge layers must not violate

---

## Reference Note for Beads

Every Epic 05 bead should reference this file.

Suggested annotation line:

`Reference doc: 000-docs/epics/epic-05-trigger-harness-and-skill-roster-simulation.md`

Suggested instruction line:

`This task is governed by the epic reference doc above. Follow its scope, dependencies, acceptance gates, evidence requirements, and out-of-scope constraints.`
