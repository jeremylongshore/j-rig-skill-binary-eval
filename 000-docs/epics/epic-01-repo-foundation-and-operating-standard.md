# Epic 01 -- Repo Foundation and Operating Standard

## Purpose

This epic establishes the canonical repository foundation for J-Rig Binary Eval.

Its purpose is to create a stable, durable, and clearly documented starting point for all later implementation work. This includes repo shape, workspace boundaries, package layout, Node/TypeScript/pnpm baseline, initial quality guardrails, repo-level operating guidance, and repo-local Beads setup.

This epic intentionally does **not** build the actual eval harness yet. It builds the operating ground the harness will stand on.

---

## Product Context

J-Rig Binary Eval is a Claude-native evaluation harness and rollout gate for Claude Skills.

The product will eventually evaluate:

- package integrity
- trigger quality
- functional quality
- regression protection
- baseline/no-skill value
- model variance
- rollout safety

Before any of that can be implemented safely, the repo needs:

- clear workspace structure
- stable tooling baseline
- durable documentation
- explicit operating standards
- repo-local Beads tracking
- evidence-driven closeout expectations

Epic 01 exists to create that foundation.

---

## In Scope

This epic includes:

- auditing the current repository starting point
- normalizing or creating the monorepo/workspace structure
- setting up the root package/workspace configuration
- setting up Node.js, TypeScript, and pnpm baseline config
- creating package placeholders for future implementation
- adding initial lint/format/test baseline
- creating durable repo docs
- creating repo-level CLAUDE.md
- initializing repo-local Beads
- creating the 10-epic top-level tracking structure
- capturing evidence and producing an end-of-epic AAR

---

## Explicitly Out of Scope

This epic does **not** include:

- Anthropic API integration
- trigger simulation
- functional execution harness
- evaluation logic
- judge logic
- SQLite persistence implementation
- CLI feature implementation beyond baseline scaffolding
- optimizer logic
- dashboard implementation
- marketplace/team integration work

If work falls into those areas, it belongs to later epics.

---

## Dependencies

### Depends on

- none

### Blocks

This epic blocks all later epics because they all depend on:

- a coherent repo structure
- agreed package layout
- shared tooling baseline
- docs and operating guidance
- initialized Beads structure

---

## Deliverables

By the end of Epic 01, the repo should have:

- a clean root workspace configuration
- pnpm workspace declarations
- TypeScript baseline configuration
- package folders for future work
- baseline lint/format/test scripts
- README.md
- repo-level CLAUDE.md
- epic/planning docs under durable documentation
- repo-local Beads initialized
- top-level epic structure created in Beads
- an end-of-epic AAR with evidence

---

## Child Beads

### 01.1 -- Audit the current repository starting point

**Purpose**
Inspect the repo before changing anything. Determine whether there is already partial setup, stale scaffolding, duplicate config, broken docs, or prior drift that must be normalized rather than recreated.

**Acceptance**
- Current repo structure is inspected and summarized.
- Existing `.git/`, `.beads/`, docs, config, packages, scripts, and baseline tooling are reviewed.
- A clear distinction is made between:
  - usable existing work
  - partial work that needs repair
  - drift or broken setup that should be replaced
- Findings are captured in a durable note or closeout summary.

**Dependencies**
- Depends on: none
- Blocks: 01.2, 01.3, 01.4, 01.5, 01.6, 01.7

**Evidence**
- repo inventory summary
- list of existing files/directories reviewed
- note on what was kept vs normalized vs removed

---

### 01.2 -- Establish the workspace and package skeleton

**Purpose**
Create or normalize the workspace layout so the repo has a clear, durable structure for CLI-first TypeScript development.

**Acceptance**
- Root workspace structure is coherent.
- Expected top-level directories exist or are intentionally documented if deferred.
- Package boundaries are clear and future-proof.
- Workspace config reflects intended package structure.

**Dependencies**
- Depends on: 01.1
- Blocks: 01.3, 01.4, 01.5

**Evidence**
- directory tree
- workspace config files
- notes on package boundary decisions

**Target structure**
- `packages/cli`
- `packages/core`
- `packages/db`
- `packages/dashboard` (placeholder allowed)
- `eval-packs/`
- `tests/`
- `docs/` or `000-docs/` per repo convention

---

### 01.3 -- Install the TypeScript and Node operating baseline

**Purpose**
Set the technical runtime baseline so future implementation work does not reinvent environment assumptions later.

**Acceptance**
- Root `package.json` exists and is coherent.
- `pnpm-workspace.yaml` exists and is correct.
- `tsconfig.json` or equivalent shared config exists.
- Node.js version expectation is documented.
- Shared workspace scripts are defined cleanly.

**Dependencies**
- Depends on: 01.2
- Blocks: 01.4, 01.6

**Evidence**
- root config files
- successful install/bootstrap output
- notes on environment assumptions

---

### 01.4 -- Add the quality guardrails and developer scripts

**Purpose**
Set up the first layer of quality protection so the repo does not drift silently as future epics add real product logic.

**Acceptance**
- Basic linting is wired.
- Basic formatting is wired.
- Basic test runner baseline exists.
- Workspace scripts for validation are present.
- The repo has at least a minimal "healthy baseline" command path.

**Dependencies**
- Depends on: 01.2, 01.3
- Blocks: 01.6, 01.7

**Evidence**
- command outputs for install/lint/test baseline
- config files for lint/test/format tooling
- note on what is baseline vs deferred

---

### 01.5 -- Create the canonical documentation and operating guidance

**Purpose**
Create the durable human layer of the repo so future Claude Code sessions and human contributors have a clear operating model.

**Acceptance**
- README.md exists and accurately describes the repo.
- CLAUDE.md exists and defines repo-specific working rules.
- Durable planning docs for the project exist.
- The docs match the actual repo state, not fantasy future state.
- The docs explain current stage and what comes next.

**Dependencies**
- Depends on: 01.2
- Blocks: 01.7

**Evidence**
- README
- CLAUDE.md
- planning docs path list
- note on key decisions documented

**Required minimum docs**
- `README.md`
- `CLAUDE.md`
- this epic reference file
- a master blueprint or index doc for the 10-epic plan

---

### 01.6 -- Initialize repo-local Beads and the 10-epic tracking structure

**Purpose**
Make Beads the official execution backbone of the repo from day one.

**Acceptance**
- `.beads/` exists repo-locally.
- Beads is initialized properly for this repo.
- The 10 top-level epics exist in Beads with readable names.
- Epic 01 child tasks exist and match this reference document.
- Annotations are clear, human-readable, and useful.
- Dependencies reflect real execution order.

**Dependencies**
- Depends on: 01.3, 01.4
- Blocks: 01.7

**Evidence**
- Beads list/status output
- epic/task inventory
- note on naming/dependency conventions used

**Top-level epic names to create**
1. Epic 01 -- Repo Foundation and Operating Standard
2. Epic 02 -- Spec Layer and Contract System
3. Epic 03 -- Package Integrity and Deterministic Checks
4. Epic 04 -- Evidence Layer, Persistence, and Run Lifecycle
5. Epic 05 -- Trigger Harness and Skill Roster Simulation
6. Epic 06 -- Functional Execution Harness and Observation Layer
7. Epic 07 -- Judgment Layer, Calibration, and Model Matrix
8. Epic 08 -- Regression, Baseline, Scoring, CLI, and CI Gate
9. Epic 09 -- Optimizer and Experiment Engine
10. Epic 10 -- Team Product, Eval Packs, and Drift Operations

---

### 01.7 -- Capture evidence, verify the foundation, and close Epic 01 cleanly

**Purpose**
Close the epic with proof, not vibes.

**Acceptance**
- Final repo structure is verified.
- Baseline scripts are executed and results recorded.
- Docs are reviewed for alignment with actual state.
- Beads statuses are accurate.
- End-of-epic AAR is created.
- Open risks and inherited next steps are explicitly documented.

**Dependencies**
- Depends on: 01.4, 01.5, 01.6
- Blocks: Epic 02

**Evidence**
- install/lint/test outputs
- final directory tree
- Beads status snapshot
- AAR file
- list of inherited next-step items

---

## Technical Design Notes

### Workspace shape
The repo should be organized as a pnpm workspace with clear future boundaries:

- `packages/cli` for the command-line entrypoint
- `packages/core` for parsing, runner, judge, and shared logic later
- `packages/db` for persistence and schema later
- `packages/dashboard` as a future-facing placeholder
- `eval-packs/` for reusable eval packs later
- `tests/` for project-level tests
- `000-docs/` or `docs/` for durable planning and reference docs

### Node and TypeScript assumptions
- Node 20+
- TypeScript-first
- pnpm workspace as package manager
- CLI-first early product posture

### Repo discipline
- repo-local git only
- repo-local Beads only
- durable docs checked in
- evidence captured at phase close
- no jumping ahead into future epic logic during this epic

---

## Validation and Acceptance Gates

Epic 01 is only complete if all of the following are true:

- the repo structure is coherent and intentional
- workspace install succeeds
- shared baseline scripts run
- docs are present and aligned
- Beads is initialized and usable
- the 10-epic top-level structure exists
- Epic 01 child beads exist and reflect this reference doc
- an end-of-epic AAR exists
- the repo is genuinely ready for Epic 02

---

## Evidence Required for Closeout

At closeout, capture:

- repo inventory summary
- final directory tree
- root config file list
- command output for install
- command output for lint baseline
- command output for test baseline
- README path
- CLAUDE.md path
- Beads status output
- AAR path
- explicit list of carry-forward items for Epic 02

---

## Risks and Edge Cases

### Existing partial setup may already exist
The repo may not be greenfield. Existing work must be normalized instead of blindly replaced.

### Over-scaffolding future phases
It is easy to build too much too early. This epic must stay focused on foundation, not implementation.

### Docs drifting from actual state
README and CLAUDE.md must reflect reality, not aspirational architecture that has not shipped yet.

### Weak Beads setup
If Beads is added lazily, later epics will have poor execution hygiene. Naming, annotations, and dependencies must be clear now.

### Fake closeout
This epic must not be marked done unless the repo can actually be bootstrapped and used as a foundation.

---

## Claude Code Execution Notes

When Claude Code works this epic, it should:

- verify current repo state first
- inspect prior partial work before creating anything new
- normalize instead of duplicate when possible
- keep changes inside this repo only
- initialize Beads repo-locally
- create top-level epic tracking structure
- only actively execute Epic 01 in this pass
- avoid jumping into trigger, judge, persistence, optimizer, or dashboard logic
- capture evidence during execution
- produce a concise but durable AAR at the end

### Mandatory workflow reminders
- verify prior work before adding new work
- check comments/fixes if this is a follow-up pass
- run a repo sweep when relevant
- keep Beads updated as truth, not as a cleanup task after the fact

---

## Suggested Branch / Commit / PR Discipline

### Branch
`feature/epic-01-repo-foundation-operating-standard`

### Commit style
- `feat(epic-01): scaffold workspace and package structure`
- `feat(epic-01): add typescript and pnpm baseline`
- `feat(epic-01): add repo docs and operating guidance`
- `chore(epic-01): initialize beads structure`
- `test(epic-01): verify install lint and test baseline`
- `docs(epic-01): add epic 01 aar`

### PR title
`[EPIC 01] Repo foundation and operating standard`

---

## AAR Requirements

The Epic 01 AAR must include:

### What shipped
- what was created
- what was normalized
- what was intentionally deferred

### Evidence
- commands run
- scripts verified
- docs created
- Beads state
- repo readiness proof

### Open risks
- what is still thin
- what later epics depend on
- any known shortcuts taken in this epic

### What Epic 02 inherits
- exact next-step expectations
- any schema/design assumptions already introduced
- any repo constraints Epic 02 must respect

---

## Reference Note for Beads

Every Epic 01 bead should reference this file.

Suggested annotation line:

`Reference doc: 000-docs/epics/epic-01-repo-foundation-and-operating-standard.md`

Suggested instruction line:

`This task is governed by the epic reference doc above. Follow its scope, dependencies, acceptance gates, evidence requirements, and out-of-scope constraints.`
