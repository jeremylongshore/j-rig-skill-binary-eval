# Epic 02 -- Spec Layer and Contract System

## Purpose

This epic defines the formal language of J-Rig Binary Eval.

Its purpose is to create the schema, validation rules, parsing utilities, and authoring expectations for the two most important control artifacts in the product:

- the **eval spec**
- the **eval contract**

If these two artifacts are weak, ambiguous, or inconsistently enforced, the rest of the system will become unreliable. This epic exists to make the product's control plane explicit, machine-validated, and human-readable.

This epic is where J-Rig Binary Eval stops being "an idea about testing skills" and starts becoming a system with a durable, enforceable configuration model.

---

## Product Context

J-Rig Binary Eval is a Claude-native evaluation harness and rollout gate for Claude Skills.

The product is built around the idea that every new or changed `SKILL.md` should be evaluated through explicit, evidence-backed rules rather than intuition.

Those rules need a canonical representation.

Epic 02 creates that representation by defining:

- how an eval spec is written
- how an eval contract is written
- how criteria are structured
- how test cases are represented
- how sibling-skill context is encoded
- how invalid configurations fail
- how authors get useful diagnostics when they make mistakes

This epic does **not** run the harness yet.
It defines the source-of-truth configuration that the harness will later execute.

---

## In Scope

This epic includes:

- designing the eval spec schema
- designing the eval contract schema
- designing criterion schema and test case schema
- designing context and sibling-skill schema
- building YAML parsing utilities
- building schema validation with strict enforcement
- building SKILL.md parsing utilities for frontmatter/body extraction
- creating valid/invalid fixture examples
- creating useful diagnostics and author-facing validation errors
- documenting author expectations for specs and contracts

---

## Explicitly Out of Scope

This epic does **not** include:

- trigger simulation execution
- functional execution harness
- Anthropic API calls
- LLM judges
- persistence/database implementation
- regression compare logic
- baseline/no-skill compare
- optimizer implementation
- dashboard work

This epic is about **formal schema and parsing**, not runtime evaluation.

---

## Dependencies

### Depends on

- Epic 01 -- Repo Foundation and Operating Standard

### Blocks

This epic blocks:

- Epic 03 -- Package Integrity and Deterministic Checks
- Epic 05 -- Trigger Harness and Skill Roster Simulation
- Epic 06 -- Functional Execution Harness and Observation Layer
- Epic 07 -- Judgment Layer, Calibration, and Model Matrix
- Epic 08 -- Regression, Baseline, Scoring, CLI, and CI Gate
- Epic 09 -- Optimizer and Experiment Engine

These later epics depend on a stable spec and contract model.

---

## Deliverables

By the end of Epic 02, the repo should have:

- a formal eval spec schema
- a formal eval contract schema
- criterion schema definitions
- test case schema definitions
- sibling/context schema definitions
- YAML parser + validator utilities
- SKILL.md parsing utilities
- valid fixtures
- invalid fixtures
- tests for schema parsing and failure modes
- author-facing docs describing how to write specs and contracts
- an end-of-epic AAR with evidence

---

## Child Beads

### 02.1 -- Design the eval spec schema

**Purpose**
Define the top-level shape of the eval spec so it can act as the machine-readable source of truth for how a skill should be evaluated.

**Acceptance**
- A clear schema exists for eval spec metadata and structure.
- The schema supports criteria, context, tiers, thresholds, and future extensibility.
- The distinction between spec-level fields and contract-level fields is explicit.
- The spec format is documented with at least one representative example.

**Dependencies**
- Depends on: Epic 01 complete
- Blocks: 02.2, 02.3, 02.4, 02.6

**Evidence**
- schema file(s)
- example valid spec
- notes on key design decisions

---

### 02.2 -- Design the eval contract schema

**Purpose**
Define the "definition of done" layer that captures what the skill is expected to do and what must never happen.

**Acceptance**
- A contract schema exists for purpose, trigger boundaries, blockers, evidence rules, safety boundaries, and baseline expectations.
- The contract is clearly distinct from the broader spec while still composing cleanly with it.
- The schema supports the product principle that rollout criteria should be pre-negotiated, not improvised after a run.
- At least one representative valid contract exists.

**Dependencies**
- Depends on: 02.1
- Blocks: 02.4, 02.6

**Evidence**
- contract schema file(s)
- example valid contract
- notes on why contract fields were separated from spec fields

---

### 02.3 -- Define criterion and test case schemas

**Purpose**
Model the smallest evaluation units in a way that is strict, expressive, and future-proof.

**Acceptance**
- Criterion schema supports:
  - binary criteria
  - blockers
  - weighted criteria
  - deterministic checks
  - judge-based checks
  - regression-critical checks
  - pack-sensitive checks
  - baseline-sensitive checks
- Test case schema supports:
  - core
  - edge
  - regression
  - adversarial tiers
  - optional context hints
  - expected trigger behavior
  - expected artifact/output expectations where relevant
- The distinction between criterion definitions and concrete test cases is clean.

**Dependencies**
- Depends on: 02.1
- Blocks: 02.4, 02.6, later execution epics

**Evidence**
- criterion schema
- test case schema
- examples spanning multiple criterion/test-case types

---

### 02.4 -- Build YAML parsing and validation utilities

**Purpose**
Implement the parsing and validation layer that turns author-written YAML into safe internal structures.

**Acceptance**
- YAML specs can be parsed reliably.
- Invalid YAML fails cleanly.
- Structurally invalid but syntactically valid YAML fails with useful diagnostics.
- Validation is strict and explicit.
- The parser does not silently coerce obviously broken values into "best effort" behavior.

**Dependencies**
- Depends on: 02.1, 02.2, 02.3
- Blocks: 02.6, 02.7, future runtime epics

**Evidence**
- parser utility files
- validation utility files
- tests for valid/invalid YAML
- sample error outputs

---

### 02.5 -- Build SKILL.md frontmatter and body parsing utilities

**Purpose**
Create a safe parser for `SKILL.md` that separates YAML frontmatter from markdown body without fragile regex hacks.

**Acceptance**
- `SKILL.md` files can be parsed into structured frontmatter + markdown body.
- Parsing uses AST/frontmatter tooling, not brittle ad hoc regex.
- Malformed frontmatter fails clearly.
- Body extraction is stable and suitable for later runtime use.
- Parsing behavior is documented.

**Dependencies**
- Depends on: Epic 01 complete
- Blocks: Epic 03, Epic 05, Epic 06

**Evidence**
- parser implementation
- valid/invalid `SKILL.md` fixtures
- parsing tests
- notes on extracted representation

---

### 02.6 -- Create valid and invalid fixture sets

**Purpose**
Build a strong fixture library that makes the schema real, testable, and hard to accidentally loosen later.

**Acceptance**
- Valid fixtures exist for:
  - eval spec
  - eval contract
  - criteria
  - test cases
  - `SKILL.md`
- Invalid fixtures exist for:
  - malformed YAML
  - missing required fields
  - incorrect types
  - logically inconsistent contract/spec combinations
  - malformed `SKILL.md` frontmatter
- Fixtures are organized predictably and used in tests.

**Dependencies**
- Depends on: 02.1, 02.2, 02.3, 02.4, 02.5
- Blocks: 02.7 and future regression of schema quality

**Evidence**
- fixture tree
- tests referencing fixtures
- notes on fixture naming conventions

---

### 02.7 -- Write author-facing schema and contract documentation

**Purpose**
Document how authors should write specs and contracts so later users do not need to reverse-engineer the product from source code.

**Acceptance**
- There is a durable document explaining:
  - what an eval spec is
  - what an eval contract is
  - how they differ
  - how criteria should be written
  - how test cases should be written
  - common validation failures
- The docs include examples and anti-examples.
- The docs align with the implemented schema, not an aspirational future schema.

**Dependencies**
- Depends on: 02.4, 02.5, 02.6
- Blocks: good author experience in all future epics

**Evidence**
- docs path(s)
- examples included in docs
- note that docs were checked against implementation

---

### 02.8 -- Capture evidence, verify schema stability, and close Epic 02 cleanly

**Purpose**
Close the epic with proof that the schema layer works and is ready to support runtime epics.

**Acceptance**
- All schema parsing tests pass.
- Valid examples parse successfully.
- Invalid examples fail in expected ways.
- Docs are aligned to implementation.
- Beads statuses are accurate.
- End-of-epic AAR is created.
- Explicit carry-forward notes for Epic 03 and later runtime epics are written.

**Dependencies**
- Depends on: 02.4, 02.5, 02.6, 02.7
- Blocks: Epic 03

**Evidence**
- test results
- validation outputs
- docs paths
- AAR path
- carry-forward summary

---

## Technical Design Notes

### Eval spec versus eval contract

These two artifacts must be distinct.

**Eval spec** is the machine-readable evaluation definition:
- criteria
- test cases
- context
- thresholds
- modes
- tiers

**Eval contract** is the human-readable, pre-negotiated definition of done:
- what the skill is for
- what should trigger it
- what should not trigger it
- which blockers are sacred
- what counts as success
- what safety boundaries matter
- what baseline/no-skill behavior is expected

The system must compose them cleanly without collapsing them into one vague file.

### Parser and schema philosophy

The schema layer should prefer:

- explicit validation
- strong typing
- rich diagnostics
- predictable failure
- low magic
- stable future extensibility

The product should not silently "help" users by guessing broken configurations into validity.

### SKILL.md parsing philosophy

Use frontmatter-aware markdown parsing.

Do **not**:
- regex your way through unknown markdown structure
- rely on brittle line slicing
- hardcode assumptions that will fail on real-world files

The output representation should be reusable in later epics for:
- package integrity checks
- trigger simulation
- functional execution context

---

## Validation and Acceptance Gates

Epic 02 is only complete if all of the following are true:

- valid eval specs parse successfully
- invalid eval specs fail with useful diagnostics
- valid eval contracts parse successfully
- invalid eval contracts fail with useful diagnostics
- criteria and test cases have strict schema enforcement
- `SKILL.md` parsing works for both valid and malformed inputs
- fixtures exist and are used in tests
- docs exist and match implemented behavior
- Beads statuses reflect actual completion
- the repo is genuinely ready for deterministic and runtime evaluation work in Epic 03+

---

## Evidence Required for Closeout

At closeout, capture:

- schema file paths
- parser utility paths
- fixture directory paths
- docs paths
- test outputs for valid and invalid cases
- sample diagnostic output
- summary of key schema decisions
- Epic 02 AAR path
- explicit list of inherited next-step items for Epic 03

---

## Risks and Edge Cases

### Spec and contract collapse into one muddy object
If authors cannot tell what belongs in the eval spec versus the eval contract, the product will confuse both humans and tooling.

### Weak diagnostics
If invalid configs fail with poor error messages, users will hate authoring specs and contracts.

### Over-permissive validation
If the parser is too forgiving, later runtime behavior will be brittle and hard to reason about.

### Schema drift from docs
If implementation and docs diverge now, later epics will inherit confusion.

### Regex-based `SKILL.md` parsing shortcuts
That will work until it doesn't, and when it breaks it will do so in exactly the annoying ways future epics least need.

---

## Claude Code Execution Notes

When Claude Code works this epic, it should:

- verify Epic 01 landed correctly before starting
- inspect current schema/parser/docs state if any partial work exists
- normalize existing work instead of blindly recreating it
- implement schemas and parsing utilities before runtime logic
- keep docs aligned to implementation
- use strict validation rather than permissive shortcuts
- capture evidence during execution
- create or update Beads as truth, not as cleanup after the fact
- produce a durable end-of-epic AAR

### Mandatory workflow reminders
- verify prior epic first
- check comments/fixes if this is a follow-up pass
- run a repo sweep when relevant
- do not jump ahead into trigger/functional/judge runtime behavior
- do not leave fixture coverage thin

---

## Suggested Branch / Commit / PR Discipline

### Branch
`feature/epic-02-spec-layer-and-contract-system`

### Commit style
- `feat(epic-02): add eval spec schema and validation`
- `feat(epic-02): add eval contract schema and parser`
- `feat(epic-02): add criterion and test case schemas`
- `feat(epic-02): add skill md parsing utilities`
- `test(epic-02): add valid and invalid schema fixtures`
- `docs(epic-02): document spec and contract authoring`
- `docs(epic-02): add epic 02 aar`

### PR title
`[EPIC 02] Spec layer and contract system`

---

## AAR Requirements

The Epic 02 AAR must include:

### What shipped
- schema components completed
- parsing utilities completed
- fixtures created
- docs added or updated

### Evidence
- parser/validation test output
- sample valid parse
- sample invalid parse
- docs paths
- fixture inventory

### Open risks
- any remaining schema ambiguity
- any areas intentionally deferred
- any known parsing limitations that later epics must respect

### What Epic 03 inherits
- exact schema assumptions it should build on
- parsing utilities now considered canonical
- any follow-up cleanup or strengthening tasks
- any explicit boundaries future epics must not break

---

## Reference Note for Beads

Every Epic 02 bead should reference this file.

Suggested annotation line:

`Reference doc: 000-docs/epics/epic-02-spec-layer-and-contract-system.md`

Suggested instruction line:

`This task is governed by the epic reference doc above. Follow its scope, dependencies, acceptance gates, evidence requirements, and out-of-scope constraints.`
