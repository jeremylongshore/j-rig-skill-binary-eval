# Epic 03 -- Package Integrity and Deterministic Checks

## Purpose

This epic builds the zero-API-cost validation layer for J-Rig Binary Eval.

Its purpose is to catch cheap, obvious, and structural failures before the system spends any model calls on trigger simulation, functional execution, judging, or optimization. This epic turns schema and parsing groundwork into a real preflight gate.

A skill package that is missing `SKILL.md`, has broken frontmatter, references non-existent files, uses a vague description, or fails deterministic rules should fail fast and clearly. This epic exists to make that happen.

This is the first runtime-adjacent epic, but it is still deliberately cheap and local. It is about **preflight trust**, not model-backed evaluation.

---

## Product Context

J-Rig Binary Eval is a Claude-native evaluation harness and rollout gate for Claude Skills.

Before a skill is allowed into more expensive evaluation flows, the system should be able to answer:

- does the package exist in a valid form
- does `SKILL.md` parse correctly
- do required metadata fields exist
- are obvious structure and packaging rules satisfied
- do referenced files actually exist
- are the description and package shape specific enough to justify deeper evaluation
- are simple deterministic criteria already failing

Epic 03 creates that first real gate.

If Epic 02 defined the control plane, Epic 03 begins enforcing it.

---

## In Scope

This epic includes:

- building the package integrity checker
- building the deterministic criterion/check registry
- validating referenced files and simple package relationships
- implementing description quality heuristics
- implementing oversized/underspecified detection heuristics
- creating deterministic reporting output
- creating fixtures and tests for common package failures
- documenting which failures are caught at deterministic preflight stage
- producing a clean end-of-epic AAR

---

## Explicitly Out of Scope

This epic does **not** include:

- trigger simulation
- sibling-skill routing logic
- functional skill execution
- artifact observation
- LLM judge logic
- model matrix execution
- regression compare engine
- baseline/no-skill comparison
- optimizer logic
- dashboard implementation

This epic is about **cheap local validation**, not model-backed behavior.

---

## Dependencies

### Depends on

- Epic 01 -- Repo Foundation and Operating Standard
- Epic 02 -- Spec Layer and Contract System

### Blocks

This epic blocks:

- Epic 05 -- Trigger Harness and Skill Roster Simulation
- Epic 06 -- Functional Execution Harness and Observation Layer
- Epic 07 -- Judgment Layer, Calibration, and Model Matrix
- Epic 08 -- Regression, Baseline, Scoring, CLI, and CI Gate
- Epic 09 -- Optimizer and Experiment Engine

Those later epics assume the package and deterministic preflight layer already exists.

---

## Deliverables

By the end of Epic 03, the repo should have:

- a package integrity checker
- a deterministic check registry
- referenced-file and structural validation
- description quality heuristic checks
- package oversize/underspecification checks
- deterministic result objects suitable for later evidence storage
- tests and fixtures for common package failures
- author-facing docs describing what deterministic preflight catches
- an end-of-epic AAR with evidence

---

## Child Beads

### 03.1 -- Build the package integrity checker

**Purpose**
Create the main package validation engine that can inspect a skill package locally and determine whether it is structurally valid enough to proceed.

**Acceptance**
- The checker can locate and validate `SKILL.md`.
- It can use the canonical parsing utilities from Epic 02.
- It can identify missing required pieces of the package.
- It returns structured results rather than informal logs only.
- Failures are understandable and attributable.

**Dependencies**
- Depends on: Epic 02 complete
- Blocks: 03.2, 03.3, 03.4, 03.5, 03.6

**Evidence**
- package checker implementation
- package checker tests
- example outputs on valid and invalid packages

---

### 03.2 -- Build the deterministic check registry

**Purpose**
Create the first reusable registry of non-LLM checks so deterministic criteria can be evaluated consistently and extended later.

**Acceptance**
- A deterministic check registry exists.
- It supports at least initial patterns such as:
  - contains
  - not-contains
  - regex
  - basic structured output validity where applicable
- The registry is separated from individual package checks so it can be reused later.
- Unknown or malformed check definitions fail clearly.

**Dependencies**
- Depends on: 03.1
- Blocks: 03.6, later execution and scoring epics

**Evidence**
- deterministic registry implementation
- tests for supported check types
- failure cases for invalid check definitions

---

### 03.3 -- Validate referenced files and package relationships

**Purpose**
Ensure that when a skill references supporting files, those references are real and internally coherent.

**Acceptance**
- Referenced files inside `SKILL.md` can be detected.
- Missing referenced files are surfaced clearly.
- The system can distinguish between:
  - existing references
  - broken references
  - references to unsupported or ambiguous locations
- Results are included in package integrity reporting.

**Dependencies**
- Depends on: 03.1
- Blocks: 03.6

**Evidence**
- reference validation logic
- fixtures with valid and broken references
- tests covering multiple reference patterns

---

### 03.4 -- Implement description quality and specificity heuristics

**Purpose**
Catch weak or vague skill descriptions before trigger testing begins.

**Acceptance**
- Description heuristics exist for identifying obviously weak descriptions.
- The system can flag descriptions that are too vague, too short, missing intent specificity, or otherwise suspicious.
- The heuristics are documented as heuristic, not absolute truth.
- Results are emitted in a way that later trigger epics can build upon.

**Dependencies**
- Depends on: 03.1
- Blocks: 03.6, Epic 05

**Evidence**
- description heuristic implementation
- valid/invalid examples
- tests showing flagged vs non-flagged descriptions

---

### 03.5 -- Implement oversized and underspecified package heuristics

**Purpose**
Catch packages that are suspiciously bloated or suspiciously thin before deeper evaluation.

**Acceptance**
- The system can flag packages that appear oversized relative to the intended guidance.
- The system can flag packages that are obviously underspecified, such as missing examples or very thin instruction bodies where they are expected.
- Heuristics are clearly identified as policy/quality guidance rather than parse failures.
- Output distinguishes warnings from hard failures where appropriate.

**Dependencies**
- Depends on: 03.1
- Blocks: 03.6

**Evidence**
- oversize/underspecification heuristic implementation
- tests and fixtures
- notes explaining threshold choices

---

### 03.6 -- Produce deterministic reporting output for CLI and future evidence layers

**Purpose**
Turn deterministic preflight checks into useful structured output that both humans and later system layers can consume.

**Acceptance**
- Deterministic results can be emitted in a structured machine-readable form.
- A human-readable summary format exists.
- Output clearly distinguishes:
  - hard failures
  - warnings
  - passing checks
- Reporting aligns with future persistence/evidence expectations.

**Dependencies**
- Depends on: 03.2, 03.3, 03.4, 03.5
- Blocks: Epic 04, Epic 08, later CLI/reporting use

**Evidence**
- output format examples
- CLI-friendly reporting examples
- tests for result object shape

---

### 03.7 -- Create deterministic fixtures and failure coverage

**Purpose**
Build a test fixture library that proves the deterministic layer catches the right classes of package problems.

**Acceptance**
- Fixtures exist for:
  - missing `SKILL.md`
  - malformed frontmatter
  - missing required fields
  - broken references
  - vague descriptions
  - oversized packages
  - underspecified packages
  - deterministic rule pass/fail examples
- Tests are organized and reusable.
- Fixtures are named clearly and are easy to expand later.

**Dependencies**
- Depends on: 03.1, 03.2, 03.3, 03.4, 03.5
- Blocks: 03.8 and future regression confidence

**Evidence**
- fixture tree
- test inventory
- examples of caught failures

---

### 03.8 -- Capture evidence, document deterministic preflight, and close Epic 03 cleanly

**Purpose**
Close the epic with proof that deterministic preflight is real, useful, and ready to front-load later evaluation workflows.

**Acceptance**
- Package integrity and deterministic tests pass.
- Example failures are demonstrated and documented.
- Docs explain what deterministic preflight catches and what still requires model-backed evaluation.
- Beads statuses are accurate.
- End-of-epic AAR is created.
- Carry-forward notes for Epics 04-06 are written.

**Dependencies**
- Depends on: 03.6, 03.7
- Blocks: Epic 04 and later runtime flows

**Evidence**
- test outputs
- example package reports
- docs path(s)
- AAR path
- carry-forward notes

---

## Technical Design Notes

### Deterministic-first philosophy

J-Rig Binary Eval should always prefer catching cheap failures before expensive ones.

The product should not spend Anthropic API calls discovering that:

- `SKILL.md` is missing
- frontmatter is malformed
- required metadata is absent
- references are broken
- the package is obviously malformed
- deterministic criteria already fail

This epic exists to enforce that principle.

### Hard failure versus warning

Not every heuristic should be a hard blocker.

The deterministic layer must distinguish between:

- **hard failures**
  Example: missing `SKILL.md`, malformed frontmatter, missing required fields, broken required references

- **warnings**
  Example: vague description, suspiciously thin package, oversized instructions, missing likely-helpful examples

That distinction must be explicit in result objects and docs.

### Reuse of Epic 02 schemas

Do not reinvent schema concepts here.

This epic should consume the canonical schema and parsing layer built in Epic 02.

If implementation reveals a schema weakness, document it and patch it carefully rather than creating parallel logic.

### Reporting design

This epic's reporting output should be designed so Epic 04 can persist it cleanly and Epic 08 can surface it in CLI/CI output later.

Do not lock reporting into ad hoc console strings only.

---

## Validation and Acceptance Gates

Epic 03 is only complete if all of the following are true:

- package integrity checks run on real fixtures
- broken packages fail clearly
- deterministic criteria are evaluable and structured
- referenced-file validation works
- description heuristics work
- oversized/underspecified heuristics work
- result objects distinguish failures from warnings
- deterministic reporting exists in machine-readable and human-readable form
- fixtures and tests cover common failure modes
- docs explain deterministic scope honestly
- the repo is genuinely ready for persistence and later runtime harness work

---

## Evidence Required for Closeout

At closeout, capture:

- package checker paths
- deterministic registry paths
- fixture directory paths
- docs path(s)
- test outputs
- sample deterministic report outputs
- examples of:
  - a passing package
  - a hard-failing package
  - a warning-heavy package
- Epic 03 AAR path
- explicit carry-forward notes for Epic 04 and later runtime epics

---

## Risks and Edge Cases

### Overpromising heuristics as truth
Description quality and overspec/underspec signals are heuristics, not universal law. The product must present them honestly.

### Mixing hard failures and warnings poorly
If warnings are treated like blockers or blockers are hidden like warnings, release governance later will be muddy.

### Fragile reference parsing
Referenced-file detection must be robust enough to handle real-world markdown patterns without becoming magical or brittle.

### Deterministic registry too narrow
If the registry is too tightly coupled to one current use case, future epics will have to rework it.

### Console-only outputs
If the deterministic layer only prints strings and does not emit structured results, Epic 04 and Epic 08 will inherit unnecessary cleanup work.

---

## Claude Code Execution Notes

When Claude Code works this epic, it should:

- verify Epics 01 and 02 landed correctly before starting
- inspect existing package/parsing code first if any partial work exists
- build deterministic preflight before any model-backed logic
- reuse canonical schema/parsing utilities from Epic 02
- keep warning/failure distinctions explicit
- emit structured outputs, not just logs
- create fixtures that reflect realistic package mistakes
- document deterministic scope honestly
- produce a durable end-of-epic AAR

### Mandatory workflow reminders
- verify prior epic first
- check comments/fixes if this is a follow-up pass
- run a repo sweep when relevant
- do not jump into trigger, judge, or optimizer work
- do not hide heuristic behavior behind fake certainty

---

## Suggested Branch / Commit / PR Discipline

### Branch
`feature/epic-03-package-integrity-and-deterministic-checks`

### Commit style
- `feat(epic-03): add package integrity checker`
- `feat(epic-03): add deterministic check registry`
- `feat(epic-03): add referenced file validation`
- `feat(epic-03): add description quality heuristics`
- `feat(epic-03): add oversized and underspecified package heuristics`
- `test(epic-03): add deterministic package fixtures and coverage`
- `docs(epic-03): document deterministic preflight behavior`
- `docs(epic-03): add epic 03 aar`

### PR title
`[EPIC 03] Package integrity and deterministic checks`

---

## AAR Requirements

The Epic 03 AAR must include:

### What shipped
- package checker components completed
- deterministic registry completed
- heuristics completed
- reporting completed
- fixtures and tests completed

### Evidence
- passing/failing/warning package outputs
- deterministic test output
- docs paths
- fixture inventory
- sample structured results

### Open risks
- any heuristic thresholds that may need tuning
- any package/reference parsing limitations
- any areas intentionally deferred to later runtime epics

### What Epic 04 inherits
- deterministic result shapes now considered canonical
- preflight assumptions that persistence must store
- any reporting conventions that evidence storage must preserve
- any cleanup or refinement tasks persistence should not ignore

---

## Reference Note for Beads

Every Epic 03 bead should reference this file.

Suggested annotation line:

`Reference doc: 000-docs/epics/epic-03-package-integrity-and-deterministic-checks.md`

Suggested instruction line:

`This task is governed by the epic reference doc above. Follow its scope, dependencies, acceptance gates, evidence requirements, and out-of-scope constraints.`
