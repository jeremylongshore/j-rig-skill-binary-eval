# Epic 06 -- Functional Execution Harness and Observation Layer

## Purpose

This epic builds the functional execution harness for J-Rig Binary Eval.

Its purpose is to move beyond package quality and trigger behavior into actual skill execution. This epic creates the layer that simulates invoking a Claude Skill, captures what it produces, records artifacts and execution metadata, and stores the observed outcome as evidence for later judgment, regression, baseline, and optimization flows.

A skill can parse correctly and trigger correctly while still failing at the actual job it exists to do. Epic 06 exists to observe that reality directly.

This is the epic where J-Rig Binary Eval begins testing **what the skill actually does after selection**, not just whether it was selected.

---

## Product Context

J-Rig Binary Eval is a Claude-native evaluation harness and rollout gate for Claude Skills.

The product must ultimately be able to answer:

- once selected, does the skill perform the intended task
- does it produce the expected structure or artifact
- does it follow its own instructions
- does it fail gracefully when context is incomplete
- what files or outputs did it produce
- what was the actual observed result, not just what the assistant claimed happened
- how long did execution take
- how much did execution cost
- what later judge, regression, and optimizer layers should evaluate against

Epic 06 creates the execution and observation substrate that makes those questions answerable.

This epic is about **functional behavior and observed outcomes**, not final quality judgment.

---

## In Scope

This epic includes:

- building the skill invocation simulator
- injecting parsed `SKILL.md` body and related execution context
- defining how base path and relevant local file context are presented
- capturing raw text outputs
- capturing created artifacts where possible
- extracting text/content from artifacts when needed for later evaluation
- defining the observed outcome model
- capturing execution metadata such as timing, token use, cost, and timeout states
- persisting functional execution evidence using the Epic 04 evidence model
- documenting execution assumptions and simulation limits
- producing an end-of-epic AAR

---

## Explicitly Out of Scope

This epic does **not** include:

- final semantic judgment of execution quality
- calibration/golden judge behavior
- model matrix policy
- regression comparison policy
- baseline/no-skill comparison policy
- CLI/CI release gating policy
- optimizer logic
- team dashboard implementation
- fully mature live Claude Code runtime integration beyond clearly documented scaffolding if introduced as placeholder only

This epic is about **execution and observation**, not final scoring or governance.

---

## Dependencies

### Depends on

- Epic 01 -- Repo Foundation and Operating Standard
- Epic 02 -- Spec Layer and Contract System
- Epic 03 -- Package Integrity and Deterministic Checks
- Epic 04 -- Evidence Layer, Persistence, and Run Lifecycle
- Epic 05 -- Trigger Harness and Skill Roster Simulation

### Blocks

This epic blocks:

- Epic 07 -- Judgment Layer, Calibration, and Model Matrix
- Epic 08 -- Regression, Baseline, Scoring, CLI, and CI Gate
- Epic 09 -- Optimizer and Experiment Engine
- Epic 10 -- Team Product, Eval Packs, and Drift Operations

Later layers need real observed outcomes, artifacts, and execution evidence.

---

## Deliverables

By the end of Epic 06, the repo should have:

- a functional skill invocation simulator
- execution context injection support
- raw text output capture
- artifact capture support
- artifact extraction/post-processing support for at least initial formats
- an observed outcome model
- timing/cost/timeout metadata capture
- persisted functional execution evidence in the canonical evidence system
- docs explaining what execution simulation does and does not cover
- an end-of-epic AAR with evidence

---

## Child Beads

### 06.1 -- Build the skill invocation simulator

**Purpose**
Create the execution harness that simulates invoking a Claude Skill after it has been selected.

**Acceptance**
- The simulator can take a parsed skill and a functional test case and run them through the configured execution path.
- The simulator uses canonical parsed `SKILL.md` content rather than stringly-typed shortcuts.
- The invocation path is explicit and debuggable.
- The simulator emits structured execution records, not just console output.

**Dependencies**
- Depends on: Epics 02, 04, and 05 complete
- Blocks: 06.2, 06.3, 06.4, 06.5, 06.6

**Evidence**
- simulator implementation
- example execution records
- tests for basic invocation behavior

---

### 06.2 -- Implement execution context and base-path injection

**Purpose**
Provide the execution harness with the context a skill needs to behave meaningfully, such as base path, referenced local files, and test-case context hints.

**Acceptance**
- The harness can inject skill body context cleanly.
- Base path handling is explicit and documented.
- Related local file content can be included when required by the test case or spec.
- Missing/invalid context is surfaced clearly rather than silently ignored.
- The implementation aligns with the contract/test-case definitions from Epic 02.

**Dependencies**
- Depends on: 06.1
- Blocks: 06.3, 06.4, 06.5

**Evidence**
- context injection implementation
- examples with and without file/context hints
- tests covering valid and invalid context scenarios

---

### 06.3 -- Capture raw outputs and execution transcripts

**Purpose**
Record what the execution harness actually produced so later judgment and compare layers have something real to evaluate.

**Acceptance**
- Raw text output is captured per execution run.
- Relevant execution transcript or structured exchange data is captured in a stable form.
- Output capture is tied to canonical run records from Epic 04.
- The capture format is documented and retrieval-friendly.

**Dependencies**
- Depends on: 06.1, 06.2
- Blocks: 06.4, 06.5, 06.6, Epic 07

**Evidence**
- stored raw output examples
- retrieval example(s)
- tests for output capture and linkage

---

### 06.4 -- Capture generated artifacts and file-producing outcomes

**Purpose**
Support functional evaluation for skills that create files or structured artifacts rather than only plain text.

**Acceptance**
- The harness can capture generated artifact files where supported.
- Artifact metadata is recorded and linked to execution runs.
- File-producing skills are treated as first-class execution cases, not edge cases.
- Failure to produce an expected artifact is represented explicitly in the observed outcome.

**Dependencies**
- Depends on: 06.1, 06.2
- Blocks: 06.5, 06.6, Epic 07

**Evidence**
- artifact capture implementation
- example artifact-producing execution runs
- tests for artifact capture and missing-artifact cases

---

### 06.5 -- Implement artifact extraction and post-processing helpers

**Purpose**
Extract useful text/content from generated artifacts so later judgment and comparison layers can evaluate outputs that are not naturally plain text.

**Acceptance**
- Initial extraction helpers exist for at least the first supported formats where relevant.
- Extraction behavior is documented and test-covered.
- Extraction results are tied back to the observed outcome/evidence model.
- Unsupported artifact types fail clearly rather than silently disappearing.

**Dependencies**
- Depends on: 06.4
- Blocks: 06.6, Epic 07, Epic 08

**Evidence**
- extraction helper implementation
- example extracted content
- tests for supported and unsupported formats

---

### 06.6 -- Define and persist the observed outcome model

**Purpose**
Turn execution results into a structured "what actually happened" record that later layers can judge and compare.

**Acceptance**
- Observed outcome includes:
  - raw output or artifact result
  - success/failure/partial outcome semantics where applicable
  - artifact presence or absence
  - extracted artifact content if present
  - execution metadata references
- Observed outcomes are persisted using the Epic 04 evidence model.
- The observed outcome model is documented as the source of truth for later judgment.

**Dependencies**
- Depends on: 06.3, 06.4, 06.5
- Blocks: 06.7, Epic 07, Epic 08, Epic 09

**Evidence**
- observed outcome model implementation
- stored observed outcome examples
- tests for persistence and retrieval

---

### 06.7 -- Capture execution timing, token, cost, and timeout metadata

**Purpose**
Record the operational side of execution so later gating and optimization layers can reason about efficiency and failure modes, not just correctness.

**Acceptance**
- Execution metadata includes timing and timeout behavior where available.
- Token and/or cost metadata is captured when available from the execution path.
- Timeout or interrupted execution states are represented clearly.
- Metadata is linked to the same canonical run and observed outcome records.

**Dependencies**
- Depends on: 06.1, 06.3, 06.6
- Blocks: 06.8, Epic 08, Epic 09, Epic 10

**Evidence**
- execution metadata capture implementation
- example stored metadata records
- tests for timing/timeout/cost capture behavior

---

### 06.8 -- Document execution simulation limits, verify observation quality, and close Epic 06 cleanly

**Purpose**
Close the epic with proof that the harness can execute skills functionally and record what actually happened, while honestly documenting where simulation still differs from live runtime reality.

**Acceptance**
- Functional execution is demonstrated on realistic sample skills.
- Both text-first and artifact-producing cases are shown where supported.
- Docs explain what is simulated, what is directly observed, and what remains future live-mode work.
- Beads statuses are accurate.
- End-of-epic AAR is created.
- Carry-forward notes for Epics 07-09 are written.

**Dependencies**
- Depends on: 06.6, 06.7
- Blocks: Epic 07

**Evidence**
- example functional runs
- example observed outcome records
- example artifact extraction output
- docs path(s)
- AAR path
- carry-forward notes

---

## Technical Design Notes

### Observed outcome is the source of truth

This epic should establish a core product rule:

The system judges **observed outcomes**, not self-reported success messages.

That means the canonical evaluation target later is:
- the produced text
- the created artifact
- the extracted artifact content
- the recorded execution state
- the execution metadata

not a vague assistant claim that "the task is complete."

### Simulation first, live mode later

Epic 06 should aim for a reproducible, API-driven or harnessed simulation-first execution model.

It should be honest that some skill types may later benefit from a more live runtime mode, especially if they depend heavily on tools or shell execution. That future should be documented without blocking a useful simulation-first implementation now.

### Artifact support is not optional fluff

Many skill workflows involve creating files, documents, or structured outputs.

This epic should not assume that "text output only" is enough to represent skill success. Artifact-producing skills must be part of the model from the beginning.

### Operational metadata matters

Execution timing, timeout state, and cost are not just nice-to-have metrics. Later release gating and optimization need them, so this epic should capture them now.

### Retrieval compatibility matters

All outputs from this epic must fit the canonical evidence model and be retrievable cleanly by later judgment, compare, and dashboard layers.

---

## Validation and Acceptance Gates

Epic 06 is only complete if all of the following are true:

- the functional execution simulator runs real test cases
- execution context injection works
- raw outputs are captured
- artifact-producing executions are supported where applicable
- artifact extraction works for initial supported types
- observed outcomes are persisted
- timing/cost/timeout metadata is captured in a structured way
- docs explain simulation assumptions and limitations honestly
- the repo is genuinely ready for external judgment and later release-governance work

---

## Evidence Required for Closeout

At closeout, capture:

- simulator implementation paths
- context injection paths
- output/artifact capture paths
- extraction helper paths
- observed outcome model paths
- execution metadata capture paths
- persisted execution example(s)
- retrieved observed outcome example(s)
- test outputs
- docs path(s)
- Epic 06 AAR path
- explicit carry-forward notes for Epic 07, Epic 08, and Epic 09

---

## Risks and Edge Cases

### Simulation is mistaken for perfect runtime fidelity
If docs overclaim what the execution harness reproduces, later trust will erode.

### Text-only bias
If the epic over-optimizes for plain text outputs, file-producing skills will become second-class citizens and later require rework.

### Missing context silently degrades runs
If required execution context is absent and the system just "tries anyway" without clarity, later evaluations will be noisy and misleading.

### Artifact extraction gaps
If unsupported artifacts vanish into a black hole instead of failing clearly, later judgment will be working with incomplete evidence.

### Metadata capture is too weak
If the system does not record timeouts, timing, and cost cleanly now, later release and optimizer logic will inherit blind spots.

---

## Claude Code Execution Notes

When Claude Code works this epic, it should:

- verify Epics 01-05 landed correctly before starting
- inspect any existing execution-harness work before creating new work
- build a simulation-first functional harness
- treat observed outcomes as the canonical truth source
- support artifact-producing skills as first-class cases
- persist execution evidence using the canonical evidence model
- capture operational metadata cleanly
- document simulation limitations honestly
- produce a durable end-of-epic AAR

### Mandatory workflow reminders
- verify prior epic first
- check comments/fixes if this is a follow-up pass
- run a repo sweep when relevant
- do not jump into semantic judgment or release scoring here
- do not treat assistant self-report as success evidence

---

## Suggested Branch / Commit / PR Discipline

### Branch
`feature/epic-06-functional-execution-harness-and-observation-layer`

### Commit style
- `feat(epic-06): add skill invocation simulator`
- `feat(epic-06): add execution context and base-path injection`
- `feat(epic-06): capture raw outputs and transcripts`
- `feat(epic-06): add artifact capture support`
- `feat(epic-06): add artifact extraction helpers`
- `feat(epic-06): add observed outcome model and persistence`
- `feat(epic-06): add execution metadata capture`
- `test(epic-06): add functional execution fixtures and coverage`
- `docs(epic-06): document execution harness behavior and limits`
- `docs(epic-06): add epic 06 aar`

### PR title
`[EPIC 06] Functional execution harness and observation layer`

---

## AAR Requirements

The Epic 06 AAR must include:

### What shipped
- execution simulator completed
- context injection completed
- output and artifact capture completed
- extraction helpers completed
- observed outcome model completed
- metadata capture completed
- docs and tests completed

### Evidence
- sample text-oriented functional run
- sample artifact-producing functional run
- persisted observed outcome example
- metadata capture example
- test outputs
- docs paths

### Open risks
- any known simulation limitations
- any artifact formats deferred
- any tool-heavy skill cases still only partially represented

### What later epics inherit
- observed outcome structures now considered canonical
- artifact extraction expectations future judgment must respect
- execution metadata conventions later scoring/optimizer work must use
- any simulation constraints later layers must not ignore

---

## Reference Note for Beads

Every Epic 06 bead should reference this file.

Suggested annotation line:

`Reference doc: 000-docs/epics/epic-06-functional-execution-harness-and-observation-layer.md`

Suggested instruction line:

`This task is governed by the epic reference doc above. Follow its scope, dependencies, acceptance gates, evidence requirements, and out-of-scope constraints.`
