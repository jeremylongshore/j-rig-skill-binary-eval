# Epic 08 -- Regression, Baseline, Scoring, CLI, and CI Gate

## Purpose

This epic turns J-Rig Binary Eval from an evaluation harness into a release-governance system.

Its purpose is to compare runs over time, detect regressions, measure whether a skill still adds value over the no-skill baseline, aggregate evaluation results into transparent launch-readiness outputs, expose the primary CLI workflows, and enforce those results in CI.

A system that can evaluate but cannot decide what to do with the results is still incomplete. Epic 08 exists to convert stored evidence and criterion judgments into actionable outcomes such as pass, warn, block, and obsolete-review.

This is the epic where J-Rig Binary Eval becomes the actual **rollout gate** for Claude Skills.

---

## Product Context

J-Rig Binary Eval is a Claude-native evaluation harness and rollout gate for Claude Skills.

The product must ultimately be able to answer:

- did this version regress relative to a prior version
- did a sacred regression case break
- did blocker criteria newly fail
- did the skill improve overall
- does the skill still outperform the no-skill baseline
- should this rollout pass, warn, block, or be flagged for obsolete review
- can a skill author run this locally from the CLI
- can CI enforce the result automatically on changed skills

Epic 08 is where those answers become explicit product behavior.

This epic is not about exploring possibilities. It is about **making release decisions legible, enforceable, and automatable**.

---

## In Scope

This epic includes:

- implementing the regression comparison engine
- implementing sacred regression enforcement
- implementing baseline/no-skill comparison
- implementing score aggregation and launch-readiness logic
- implementing recommendation outcomes:
  - pass
  - warn
  - block
  - obsolete-review
- implementing CLI commands for local workflows
- implementing CI integration and PR-style reporting
- persisting comparison and recommendation evidence
- documenting scoring and governance behavior
- producing an end-of-epic AAR

---

## Explicitly Out of Scope

This epic does **not** include:

- the single-change optimizer
- experiment/revert loops
- dashboard UI
- organization/team product polish
- marketplace-facing UI flows
- broad non-Claude expansion
- overly magical or opaque scoring systems

This epic is about **release governance and execution surfaces**, not optimizer automation or team product polish.

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

### Blocks

This epic blocks:

- Epic 09 -- Optimizer and Experiment Engine
- Epic 10 -- Team Product, Eval Packs, and Drift Operations

Those later epics need real release outcomes, scoring, compare logic, and CLI/CI surfaces.

---

## Deliverables

By the end of Epic 08, the repo should have:

- a regression comparison engine
- sacred regression detection and enforcement
- baseline/no-skill comparison support
- transparent score aggregation
- launch-readiness recommendation logic
- local CLI workflows for init/run/compare/ci or equivalent agreed command set
- CI integration for changed skill evaluation
- report outputs suitable for PR/CI surfaces
- persisted compare/recommendation evidence
- docs explaining how governance and scoring work
- an end-of-epic AAR with evidence

---

## Child Beads

### 08.1 -- Build the regression comparison engine

**Purpose**
Compare evaluation runs over time so the system can identify what improved, what regressed, and what stayed stable.

#### Acceptance

- The system can compare at least two runs tied to the same skill/version lineage.
- Comparison identifies:
  - newly passing results
  - newly failing results
  - stable passes
  - stable failures
- Comparison can operate at criterion level and test-case level where data exists.
- Results are structured and retrievable, not just printed.

#### Dependencies

- Depends on: Epics 04 and 07 complete
- Blocks: 08.2, 08.3, 08.4, 08.5

#### Evidence

- comparison engine implementation
- sample before/after compare outputs
- tests for compare behavior

---

### 08.2 -- Enforce sacred regression and blocker failure rules

**Purpose**
Implement the non-negotiable protection rules that prevent a rollout from passing when it breaks sacred regression cases or newly fails blockers.

#### Acceptance

- The system can identify sacred regression failures explicitly.
- The system can identify newly failing blocker criteria explicitly.
- These outcomes are represented as release-blocking signals.
- Logic is documented and test-covered.
- The implementation makes clear that blockers cannot be averaged away.

#### Dependencies

- Depends on: 08.1
- Blocks: 08.4, 08.5, 08.6, Epic 09

#### Evidence

- sacred regression enforcement implementation
- blocked-case examples
- tests covering blocker and sacred-failure behavior

---

### 08.3 -- Implement baseline and no-skill comparison

**Purpose**
Measure whether a skill still adds value relative to running without the skill loaded.

#### Acceptance

- The system can compare skill-on vs skill-off runs where baseline data exists.
- Baseline deltas are represented explicitly.
- The system can identify cases where:
  - the skill clearly helps
  - the skill barely helps
  - the skill harms
  - the skill appears obsolete or nearly obsolete
- Output is documented and retrievable.

#### Dependencies

- Depends on: Epics 04, 06, and 07 complete
- Blocks: 08.4, 08.5, 08.6, Epic 09, Epic 10

#### Evidence

- baseline compare implementation
- example baseline reports
- tests for positive/neutral/negative baseline deltas

---

### 08.4 -- Implement transparent score aggregation and launch-readiness logic

**Purpose**
Turn criterion and comparison evidence into a clear, explainable launch-readiness calculation without black-box magic.

#### Acceptance

- The aggregation formula is explicit and documented.
- The system can compute:
  - weighted score
  - blocker pass/fail status
  - sacred regression status
  - baseline signal contribution where applicable
- Launch-readiness logic is deterministic and test-covered.
- There is no silent override path for blocker failures.

#### Dependencies

- Depends on: 08.1, 08.2, 08.3
- Blocks: 08.5, 08.6, 08.7, Epic 09

#### Evidence

- score aggregation implementation
- example score breakdowns
- tests for calculation behavior

---

### 08.5 -- Implement recommendation outcomes: pass, warn, block, obsolete-review

**Purpose**
Translate scoring and governance signals into the canonical product decisions later surfaces will use.

#### Acceptance

- The system produces recommendation states including:
  - pass
  - warn
  - block
  - obsolete-review
- Recommendation reasons are explicit.
- Recommendation objects are persisted and retrievable.
- The mapping from evidence to recommendation is documented and test-covered.

#### Dependencies

- Depends on: 08.2, 08.3, 08.4
- Blocks: 08.6, 08.7, 08.8, Epic 09, Epic 10

#### Evidence

- recommendation engine implementation
- examples for each recommendation state
- tests for recommendation behavior

---

### 08.6 -- Implement primary CLI workflows

**Purpose**
Expose the core local user workflows so skill authors and maintainers can actually use the product outside of test code.

#### Acceptance

- CLI commands exist for the agreed local workflows, such as:
  - init
  - run
  - compare
  - ci
- Commands are usable and documented.
- CLI output is readable and aligned with future CI/reporting needs.
- Error behavior is explicit and helpful.

#### Dependencies

- Depends on: 08.4, 08.5
- Blocks: 08.7, 08.8, Epic 10

#### Evidence

- CLI command implementation
- sample CLI outputs
- tests covering command behavior

---

### 08.7 -- Implement CI/PR gating and report output

**Purpose**
Bring release governance into automated repo workflows.

#### Acceptance

- CI can evaluate changed skills or the configured scope.
- CI output includes recommendation state and supporting signals.
- Blocker and sacred regression failures can fail CI appropriately.
- PR/report output is understandable and concise.
- Behavior is documented for maintainers.

#### Dependencies

- Depends on: 08.5, 08.6
- Blocks: 08.8, Epic 09, Epic 10

#### Evidence

- CI workflow/config
- example CI report output
- tests or dry-run evidence of CI gating behavior

---

### 08.8 -- Persist compare/recommendation evidence, verify release governance, and close Epic 08 cleanly

**Purpose**
Close the epic with proof that J-Rig Binary Eval can now make and enforce release decisions.

#### Acceptance

- Compare outputs and recommendation objects are persisted.
- CLI and CI workflows are demonstrated with realistic examples.
- Docs explain scoring, baseline, regression, and recommendation logic honestly.
- Beads statuses are accurate.
- End-of-epic AAR is created.
- Carry-forward notes for Epics 09 and 10 are written.

#### Dependencies

- Depends on: 08.6, 08.7
- Blocks: Epic 09

#### Evidence

- persisted compare example
- persisted recommendation example
- CLI output examples
- CI output examples
- docs path(s)
- AAR path
- carry-forward notes

---

## Technical Design Notes

### Governance must be explainable

The system should not drift into opaque scoring theater.

J-Rig Binary Eval must be able to explain:

- why something passed
- why something warned
- why something blocked
- why something was flagged obsolete-review

That means score aggregation and recommendation mapping must remain transparent and testable.

### Sacred regressions are different from ordinary failures

Not all failures are equal.

This epic should preserve the product rule that sacred regressions and blocker failures are special and cannot simply be buried in a weighted average.

### Baseline matters strategically, not cosmetically

The no-skill baseline comparison is not a vanity metric.

It is how the product determines whether a skill:

- still adds value
- should be narrowed
- should be merged
- should be retired

This should be represented as a first-class comparison surface.

### CLI is the real first UI

Before a dashboard exists, the CLI is the product.

That means:

- commands must be coherent
- output must be useful
- local author workflows must be friction-aware
- errors must not be cryptic

### CI is where "rollout gate" becomes literal

This epic should make the phrase "rollout gate" true in practice.

A system that can only print interesting reports locally is not yet a real gate.

---

## Validation and Acceptance Gates

Epic 08 is only complete if all of the following are true:

- compare engine works
- sacred regression enforcement works
- baseline compare works
- score aggregation is explicit and tested
- recommendation states are real and persisted
- CLI local workflows are usable
- CI gating/reporting is operational
- docs explain governance logic honestly
- the repo is genuinely ready for optimizer automation and team product surfaces

---

## Evidence Required for Closeout

At closeout, capture:

- compare engine paths
- baseline compare paths
- score aggregation paths
- recommendation engine paths
- CLI command paths
- CI workflow/config paths
- persisted compare example(s)
- persisted recommendation example(s)
- sample CLI output(s)
- sample CI output(s)
- test outputs
- docs path(s)
- Epic 08 AAR path
- explicit carry-forward notes for Epic 09 and Epic 10

---

## Risks and Edge Cases

### Score aggregation becomes too magical

If later readers cannot understand how a result was computed, trust will fall fast.

### Baseline comparison is underused

If the system only computes baseline deltas but does not let them influence outcomes, obsolete skills will linger.

### CLI becomes a dumping ground

If commands are inconsistent or their outputs are messy, the product will feel weaker than it is.

### CI reports are technically correct but unreadable

A rollout gate that speaks in machine gibberish is still friction for humans.

### Sacred regression enforcement gets softened

If blocker or sacred-failure logic gains "just this once" escape hatches, the whole governance story weakens.

---

## Claude Code Execution Notes

When Claude Code works this epic, it should:

- verify Epics 01-07 landed correctly before starting
- inspect any existing compare/CLI/CI work before adding new work
- keep recommendation logic explainable and deterministic
- preserve the special treatment of blockers and sacred regressions
- treat baseline comparison as a core product surface
- make CLI output useful for real humans
- make CI output concise and actionable
- persist compare and recommendation evidence cleanly
- produce a durable end-of-epic AAR

### Mandatory workflow reminders

- verify prior epic first
- check comments/fixes if this is a follow-up pass
- run a repo sweep when relevant
- do not jump into optimizer logic here
- do not allow black-box score magic to creep in

---

## Suggested Branch / Commit / PR Discipline

### Branch

`feature/epic-08-regression-baseline-scoring-cli-and-ci-gate`

### Commit style

- `feat(epic-08): add regression comparison engine`
- `feat(epic-08): enforce sacred regression and blocker rules`
- `feat(epic-08): add baseline and no-skill comparison`
- `feat(epic-08): add score aggregation and launch-readiness logic`
- `feat(epic-08): add recommendation states and persistence`
- `feat(epic-08): add primary cli workflows`
- `feat(epic-08): add ci gate and report output`
- `test(epic-08): add regression, baseline, cli, and ci coverage`
- `docs(epic-08): document governance and scoring behavior`
- `docs(epic-08): add epic 08 aar`

### PR title

`[EPIC 08] Regression, baseline, scoring, CLI, and CI gate`

---

## AAR Requirements

The Epic 08 AAR must include:

### What shipped

- compare engine completed
- sacred regression enforcement completed
- baseline compare completed
- score aggregation completed
- recommendation engine completed
- CLI workflows completed
- CI gating completed
- docs and tests completed

### Evidence

- sample compare output
- sample sacred regression block case
- sample baseline delta report
- sample recommendation objects for pass/warn/block/obsolete-review
- sample CLI outputs
- sample CI/PR outputs
- docs paths
- test outputs

### Open risks

- any scoring thresholds likely to need tuning
- any CI ergonomics still rough
- any baseline edge cases later optimizer/team work must respect

### What later epics inherit

- canonical recommendation states
- compare and baseline outputs as source-of-truth inputs
- CLI and CI entrypoints now considered real product surfaces
- any governance assumptions optimizer and dashboard work must preserve

---

## Reference Note for Beads

Every Epic 08 bead should reference this file.

Suggested annotation line:

`Reference doc: 000-docs/epics/epic-08-regression-baseline-scoring-cli-and-ci-gate.md`

Suggested instruction line:

`This task is governed by the epic reference doc above. Follow its scope, dependencies, acceptance gates, evidence requirements, and out-of-scope constraints.`
