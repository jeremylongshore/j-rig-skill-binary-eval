# Epic 04 -- Evidence Layer, Persistence, and Run Lifecycle

## Purpose

This epic creates the durable memory of J-Rig Binary Eval.

Its purpose is to ensure that every evaluation run produces structured, inspectable, and comparable evidence rather than disappearing into transient console output. This epic defines how runs are represented, how outputs and artifacts are stored, how lifecycle states are tracked, and how later epics will retrieve prior evidence for comparison, regression detection, baseline analysis, and optimization history.

Without this epic, J-Rig Binary Eval can execute checks but cannot prove what happened over time. This epic turns one-off execution into an auditable system.

---

## Product Context

J-Rig Binary Eval is a Claude-native evaluation harness and rollout gate for Claude Skills.

The product is not just supposed to answer "what happened right now?" It must also answer:

- what happened last run
- what changed between runs
- what artifacts were produced
- what evidence supports a pass, warning, or block outcome
- what previous version should be compared against
- what regressions or improvements were observed
- what future optimizer experiments should inherit

Epic 04 builds the evidence substrate that makes all of those questions answerable.

This is the foundation for:

- regression comparison
- baseline comparison
- launch reports
- experiment history
- CI evidence
- dashboard reporting
- obsolete-review workflows later

---

## In Scope

This epic includes:

- designing the persistence model for runs and evidence
- creating the initial database schema
- implementing SQLite-first persistence
- defining the run lifecycle model and status transitions
- defining filesystem storage for outputs and artifacts
- serializing deterministic and future runtime evidence
- implementing readback/query helpers for future compare/report flows
- adding tests for persistence and retrieval
- documenting the evidence model and storage conventions
- producing an end-of-epic AAR

---

## Explicitly Out of Scope

This epic does **not** include:

- trigger simulation logic itself
- functional execution logic itself
- Anthropic API orchestration
- LLM judge logic
- regression comparison policy
- baseline scoring policy
- optimizer logic
- dashboard implementation
- PostgreSQL production deployment work

This epic is about **how evidence is stored and retrieved**, not how all future evidence is generated or interpreted.

---

## Dependencies

### Depends on

- Epic 01 -- Repo Foundation and Operating Standard
- Epic 02 -- Spec Layer and Contract System
- Epic 03 -- Package Integrity and Deterministic Checks

### Blocks

This epic blocks:

- Epic 05 -- Trigger Harness and Skill Roster Simulation
- Epic 06 -- Functional Execution Harness and Observation Layer
- Epic 08 -- Regression, Baseline, Scoring, CLI, and CI Gate
- Epic 09 -- Optimizer and Experiment Engine
- Epic 10 -- Team Product, Eval Packs, and Drift Operations

Those later epics all depend on durable evidence and prior-run retrieval.

---

## Deliverables

By the end of Epic 04, the repo should have:

- a canonical run/evidence data model
- SQLite-backed persistence for run records
- filesystem storage conventions for outputs and artifacts
- run lifecycle states and transitions
- evidence serialization utilities
- query/readback helpers for prior runs and related entities
- tests for persistence and retrieval
- docs for evidence model and storage layout
- an end-of-epic AAR with evidence

---

## Child Beads

### 04.1 -- Design the canonical run and evidence data model

**Purpose**
Define the persistent entities and relationships that represent evaluation history in the system.

#### Acceptance

- Core entities are modeled clearly.
- Relationships between skills, versions, runs, outputs, criteria, and artifacts are explicit.
- The model supports future compare, baseline, and optimizer use without immediate rework.
- The model distinguishes structured DB records from file-based artifacts cleanly.

#### Dependencies

- Depends on: Epic 03 complete
- Blocks: 04.2, 04.3, 04.4, 04.5, 04.6

#### Evidence

- schema design notes
- entity relationship definitions
- decisions documented for DB vs filesystem split

---

### 04.2 -- Implement SQLite-first persistence and schema migration baseline

**Purpose**
Create the first durable persistence layer using SQLite so local development is zero-config and evidence becomes durable immediately.

#### Acceptance

- SQLite database can be initialized locally.
- Core tables/schema are implemented.
- Migration strategy or versioning baseline exists.
- The persistence layer is compatible with future expansion rather than being a throwaway one-off.

#### Dependencies

- Depends on: 04.1
- Blocks: 04.3, 04.5, 04.6

#### Evidence

- DB schema files
- migration/bootstrap output
- tests proving records can be inserted and read back

---

### 04.3 -- Define and implement run lifecycle states

**Purpose**
Model the lifecycle of an evaluation run explicitly so later phases can reason about status and partial failure correctly.

#### Acceptance

- Run states are defined, such as:
  - pending
  - running
  - completed
  - failed
  - blocked
  - timed_out
  - canceled if intentionally supported
- Allowed transitions are documented and implemented.
- Partial or interrupted runs are handled consistently.
- Lifecycle rules are test-covered.

#### Dependencies

- Depends on: 04.2
- Blocks: 04.5, 04.6, future runtime epics

#### Evidence

- lifecycle model definition
- tests for transitions
- notes on state semantics

---

### 04.4 -- Define filesystem storage layout for raw outputs and artifacts

**Purpose**
Create the file-based evidence layout for large or non-tabular data that should not live only inside the database.

#### Acceptance

- A predictable directory structure exists for run artifacts.
- The system can persist raw outputs and extracted files in stable locations.
- The split between DB metadata and filesystem artifacts is documented.
- Artifact paths can be linked back to run records cleanly.

#### Dependencies

- Depends on: 04.1
- Blocks: 04.5, 04.6, Epic 06

#### Evidence

- artifact storage layout
- example stored output/artifact files
- mapping notes between DB rows and filesystem paths

---

### 04.5 -- Implement evidence serialization and structured result persistence

**Purpose**
Persist deterministic results now and create the format future runtime results will follow later.

#### Acceptance

- Deterministic run results from Epic 03 can be serialized and stored.
- Structured result objects are persisted consistently.
- Storage preserves enough detail for later compare/report logic.
- The design anticipates future trigger/functional/judge outputs without forcing a redesign.

#### Dependencies

- Depends on: 04.2, 04.3, 04.4
- Blocks: 04.6, Epic 08, Epic 09

#### Evidence

- serializer utilities
- stored example runs
- tests for evidence persistence
- example readback of a stored deterministic run

---

### 04.6 -- Build readback and query helpers for future compare/report flows

**Purpose**
Make stored evidence usable rather than merely saved.

#### Acceptance

- There are query/readback helpers for:
  - recent runs
  - runs by skill
  - runs by version
  - outputs/artifacts tied to a run
  - criterion results tied to a run
- The retrieval layer is clean enough for later CLI, CI, compare, and dashboard use.
- Query behavior is documented.

#### Dependencies

- Depends on: 04.2, 04.3, 04.4, 04.5
- Blocks: Epic 08, Epic 09, Epic 10

#### Evidence

- query helper implementation
- tests for retrieval cases
- example readback outputs

---

### 04.7 -- Add persistence fixtures and failure coverage

**Purpose**
Create confidence that the persistence layer behaves predictably under normal and broken conditions.

#### Acceptance

- Tests exist for:
  - successful DB initialization
  - successful run persistence
  - artifact path recording
  - failed/incomplete runs
  - lifecycle edge cases
  - readback correctness
- Fixtures or example run records are organized cleanly.
- Error behavior is explicit and test-covered.

#### Dependencies

- Depends on: 04.2, 04.3, 04.4, 04.5, 04.6
- Blocks: 04.8 and future regression confidence

#### Evidence

- test inventory
- fixtures/examples
- notes on covered failure modes

---

### 04.8 -- Document the evidence model, verify persistence, and close Epic 04 cleanly

**Purpose**
Close the epic with proof that J-Rig Binary Eval now has durable run memory and evidence retrieval, not just ephemeral execution.

#### Acceptance

- DB and filesystem persistence are both demonstrated.
- Deterministic run outputs are stored and retrievable.
- Docs explain the evidence model and storage conventions clearly.
- Beads statuses are accurate.
- End-of-epic AAR is created.
- Carry-forward notes for Epics 05, 06, 08, and 09 are written.

#### Dependencies

- Depends on: 04.5, 04.6, 04.7
- Blocks: Epic 05

#### Evidence

- DB output or inspection example
- artifact tree example
- example readback output
- docs path(s)
- AAR path
- carry-forward notes

---

## Technical Design Notes

### SQLite-first philosophy

The persistence model should begin with SQLite because:

- local development should remain zero-config
- repo-level iteration should be easy
- evidence must become durable early
- future migration to PostgreSQL should be possible, but not required now

This epic should build the model so later dialect changes are feasible without redesigning the conceptual model.

### Database versus filesystem split

Not all evidence belongs in the database.

Use the database for:

- run records
- identifiers
- structured result summaries
- metadata
- links between entities
- lifecycle states

Use the filesystem for:

- raw outputs
- artifact files
- extracted artifact text when large
- JSON snapshots when useful for inspection

This split must be documented and consistent.

### Deterministic results as first-class stored evidence

Even though runtime harness work is not done yet, deterministic preflight results from Epic 03 must already persist cleanly.

That means this epic should not wait for trigger or functional execution to define the evidence shape.

### Future-proofing for compare, baseline, and optimizer

The persistence model must anticipate later needs such as:

- previous run lookup
- previous version lookup
- baseline/no-skill pairings
- experiment history
- accepted vs reverted changes

It does not need to fully implement those flows yet, but it must not trap later epics in a dead-end schema.

---

## Validation and Acceptance Gates

Epic 04 is only complete if all of the following are true:

- a canonical run/evidence model exists
- SQLite persistence works locally
- lifecycle states are explicit and implemented
- deterministic run evidence from Epic 03 can be stored
- filesystem artifact layout is real and documented
- query/readback helpers exist and work
- tests cover normal and edge persistence behavior
- docs explain the storage model honestly
- the repo is genuinely ready for trigger and functional execution evidence in later epics

---

## Evidence Required for Closeout

At closeout, capture:

- schema/model file paths
- SQLite bootstrap or migration output
- DB file location
- artifact/output storage layout
- query/readback helper paths
- test outputs
- example persisted run
- example readback output
- docs path(s)
- Epic 04 AAR path
- explicit carry-forward notes for Epic 05 and later epics

---

## Risks and Edge Cases

### DB schema too thin for future compare work

If the schema only supports today's deterministic outputs, later compare/baseline/optimizer work will be awkward.

### Everything stored in DB or everything stored in files

Either extreme is bad. The split must be intentional.

### Run lifecycle ambiguity

If `failed`, `blocked`, `timed_out`, and `completed-with-warnings` are conflated, later report logic will be muddy.

### Persistence helpers coupled to one future interface

The retrieval layer should support CLI first, but not be so CLI-specific that later CI or dashboard consumers need rewrites.

### Fake durability

If the system only writes logs and calls it "persistence," later epics will inherit pain. Evidence must be genuinely storable and retrievable.

---

## Claude Code Execution Notes

When Claude Code works this epic, it should:

- verify Epics 01-03 landed correctly before starting
- inspect any existing DB or evidence-related code first if partial work exists
- keep persistence local-first and zero-config
- treat deterministic results as first-class evidence now
- define lifecycle states explicitly
- document the DB/filesystem storage split clearly
- build retrieval helpers that later phases can actually reuse
- capture evidence during execution
- produce a durable end-of-epic AAR

### Mandatory workflow reminders

- verify prior epic first
- check comments/fixes if this is a follow-up pass
- run a repo sweep when relevant
- do not jump ahead into trigger execution or judge logic
- do not over-engineer distributed persistence too early

---

## Suggested Branch / Commit / PR Discipline

### Branch

`feature/epic-04-evidence-layer-persistence-and-run-lifecycle`

### Commit style

- `feat(epic-04): add canonical run and evidence data model`
- `feat(epic-04): add sqlite persistence baseline`
- `feat(epic-04): add run lifecycle model`
- `feat(epic-04): add artifact storage layout and serializers`
- `feat(epic-04): add readback and query helpers`
- `test(epic-04): add persistence and retrieval coverage`
- `docs(epic-04): document evidence model and storage layout`
- `docs(epic-04): add epic 04 aar`

### PR title

`[EPIC 04] Evidence layer, persistence, and run lifecycle`

---

## AAR Requirements

The Epic 04 AAR must include:

### What shipped

- persistence components completed
- lifecycle model completed
- storage layout completed
- serializers/readback helpers completed
- tests and docs completed

### Evidence

- DB initialization or migration output
- persisted deterministic run example
- filesystem artifact example
- query/readback example
- docs paths

### Open risks

- any schema areas likely to need expansion later
- any lifecycle cases intentionally deferred
- any known local-first limitations future team/product work must respect

### What Epics 05 and 06 inherit

- the run/evidence model now considered canonical
- storage conventions trigger and functional harness work must follow
- lifecycle rules later runtime execution must respect
- any follow-up cleanups later epics should not ignore

---

## Reference Note for Beads

Every Epic 04 bead should reference this file.

Suggested annotation line:

`Reference doc: 000-docs/epics/epic-04-evidence-layer-persistence-and-run-lifecycle.md`

Suggested instruction line:

`This task is governed by the epic reference doc above. Follow its scope, dependencies, acceptance gates, evidence requirements, and out-of-scope constraints.`
