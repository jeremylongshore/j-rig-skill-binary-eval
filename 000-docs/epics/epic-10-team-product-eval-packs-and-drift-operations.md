# Epic 10 -- Team Product, Eval Packs, and Drift Operations

## Purpose

This epic turns J-Rig Binary Eval from a powerful local/CI system into a durable team-facing product.

Its purpose is to add the initial team product surfaces, reusable eval packs, scheduled drift reevaluation workflows, and obsolete-review operations that make the system sustainable in real organizational use. This is the epic that packages the previous nine epics into something teams can operate, inspect, and extend over time.

A great local tool is not yet operational infrastructure. Epic 10 exists to complete that transition.

This is the epic where J-Rig Binary Eval becomes a usable **team system**, not just a strong CLI-and-CI engine.

---

## Product Context

J-Rig Binary Eval is a Claude-native evaluation harness and rollout gate for Claude Skills.

By this point in the build, the system should already be able to:

- validate skill packages
- simulate trigger behavior
- simulate functional execution
- judge observed outcomes
- compare runs and detect regressions
- compare against no-skill baseline
- gate release recommendations
- run optimizer experiments

Epic 10 turns those capabilities into operational product surfaces that help teams answer:

- what is happening across all tracked skills
- which skills are healthy, risky, drifting, or obsolete
- what experiments were run and why
- which eval packs can bootstrap new skill categories quickly
- how should scheduled reevaluation happen after model changes
- how do teams inspect and act on long-lived skill quality over time

---

## In Scope

This epic includes:

- building the initial dashboard/team-facing read surfaces
- exposing experiment history and recommendation history cleanly
- creating reusable starter eval packs
- creating organization/team integration hooks or API surfaces as needed
- implementing scheduled drift reevaluation workflows
- implementing obsolete-review workflows
- documenting ongoing operations and maintenance expectations
- producing an end-of-epic AAR

---

## Explicitly Out of Scope

This epic does **not** include:

- turning the product into a generic multi-ecosystem eval platform
- building every possible UI/reporting feature
- endless polish loops on visual design
- abandoning CLI/CI as first-class workflows
- overcomplicated enterprise orchestration beyond what the current product needs

This epic is about **operational productization**, not infinite platform sprawl.

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
- Epic 09 -- Optimizer and Experiment Engine

### Blocks

- none inside the current 10-epic v1 plan

This is the final epic in the current blueprint.

---

## Deliverables

By the end of Epic 10, the repo should have:

- an initial team-facing dashboard or equivalent read surface
- experiment history browsing
- recommendation/run history browsing
- starter reusable eval packs
- team/org integration hooks or internal API surface as appropriate
- scheduled drift reevaluation support
- obsolete-review workflow support
- documentation for ongoing operations and maintenance
- an end-of-epic AAR with evidence
- a recommended post-v1 roadmap

---

## Child Beads

### 10.1 -- Build the initial dashboard or team-facing read surface

**Purpose**
Provide a browsable interface for teams to inspect runs, recommendations, regressions, and skill health over time.

#### Acceptance

- A team-facing read surface exists.
- It can display key entities such as skills, runs, recommendations, and compare results.
- The surface is useful enough to inspect system state without dropping directly into raw database/filesystem artifacts.
- The implementation aligns with the current product scope and does not overbuild beyond the available data model.

#### Dependencies

- Depends on: Epics 04, 08, and 09 complete
- Blocks: 10.2, 10.4, 10.6

#### Evidence

- UI/read surface implementation
- example screenshots or equivalent evidence
- tests or validation for key routes/views

---

### 10.2 -- Expose experiment history and recommendation history cleanly

**Purpose**
Make it easy for teams to inspect how a skill evolved, what experiments were attempted, and why recommendations changed over time.

#### Acceptance

- Experiment history is retrievable and visible in a human-friendly form.
- Recommendation history is retrievable and visible in a human-friendly form.
- It is possible to understand:
  - what changed
  - why it changed
  - what happened after the change
  - whether it was accepted or rejected
- History views align with canonical evidence structures.

#### Dependencies

- Depends on: 10.1 and Epics 08-09 complete
- Blocks: 10.6, 10.7

#### Evidence

- history view implementation
- example experiment/recommendation history views
- tests or validation for history retrieval

---

### 10.3 -- Create starter reusable eval packs

**Purpose**
Provide reusable starting points for common Claude Skill categories so teams do not need to author every eval definition from scratch.

#### Acceptance

- Initial eval packs exist for agreed starter categories such as:
  - document creation
  - code generation
  - data analysis
  - workflow orchestration
  - safety-sensitive/tool-using skills
- Eval packs are documented and structured consistently.
- Packs align with the product's canonical spec/contract model.
- Pack reuse assumptions are documented honestly.

#### Dependencies

- Depends on: Epics 02, 03, 05, 06, and 07 complete
- Blocks: 10.6, future post-v1 adoption work

#### Evidence

- eval pack directories/files
- docs for pack usage
- validation showing packs conform to schema

---

### 10.4 -- Add organization/team integration hooks or internal API surfaces

**Purpose**
Make the system usable in shared team contexts rather than only from local CLI and CI entrypoints.

#### Acceptance

- There is an internal API or equivalent structured access surface for key data/actions where appropriate.
- The implementation supports team workflows without undermining the CLI-first foundation.
- Exposed surfaces are documented and scoped to the current product, not speculative platform sprawl.
- Security/scope boundaries are at least minimally documented where relevant.

#### Dependencies

- Depends on: 10.1 and Epics 04, 08 complete
- Blocks: 10.6, 10.7

#### Evidence

- API/integration surface implementation
- example requests or usage
- tests or validation for core integration paths

---

### 10.5 -- Implement scheduled drift reevaluation workflows

**Purpose**
Allow teams to detect when model changes, prompt shifts, or other drift causes previously healthy skills to degrade or become obsolete.

#### Acceptance

- The system can schedule or otherwise support periodic reevaluation.
- Drift reevaluation results are distinguishable from ad hoc/manual runs.
- The system can surface meaningful changes from prior known-good states.
- The workflow is documented and ties into the existing evidence/governance model.

#### Dependencies

- Depends on: Epics 04, 07, and 08 complete
- Blocks: 10.6, 10.7

#### Evidence

- scheduled reevaluation implementation
- example drift run(s)
- example drift comparison output
- tests or validation of scheduling/reevaluation logic

---

### 10.6 -- Implement obsolete-review workflow and operational triage paths

**Purpose**
Make baseline-value and drift findings actionable when a skill appears redundant, stale, or strategically weak.

#### Acceptance

- The system can surface obsolete-review as an operational state, not just a recommendation string.
- There is a documented workflow for what happens when a skill is flagged as obsolete, low-value, or drifted.
- Related states such as review-needed, retire, merge, or narrow can be represented if in scope.
- The workflow connects baseline, drift, and recommendation evidence coherently.

#### Dependencies

- Depends on: 10.2, 10.4, 10.5
- Blocks: 10.7, final closeout

#### Evidence

- obsolete-review workflow implementation
- example flagged skill case
- docs describing the operational path

---

### 10.7 -- Document operating model, verify team workflows, and close Epic 10 cleanly

**Purpose**
Close the epic with proof that the system can now be operated over time by a team, not just executed once by a developer.

#### Acceptance

- Team-facing read/report surfaces are demonstrated.
- Eval packs are documented and usable.
- Scheduled reevaluation is demonstrated.
- Obsolete-review workflow is demonstrated.
- Operational documentation exists.
- Beads statuses are accurate.
- End-of-epic AAR is created.
- A clear post-v1 roadmap is written.

#### Dependencies

- Depends on: 10.2, 10.3, 10.4, 10.5, 10.6
- Blocks: final v1 closeout

#### Evidence

- screenshots or equivalent evidence of team-facing views
- docs path(s)
- example eval pack usage
- example drift/obsolete-review output
- AAR path
- post-v1 roadmap path

---

## Technical Design Notes

### Team product should extend, not replace, CLI/CI truth

The dashboard and team surfaces are important, but they must sit on top of the same canonical evidence and governance model used by CLI/CI.

No shadow logic.
No separate truth layer.
No UI-only magic.

### Eval packs are a product moat

Reusable eval packs are one of the clearest ways the system becomes valuable faster for real users.

They should:

- reflect real categories
- be schema-valid
- be documented
- remain editable and inspectable

### Drift is not an occasional surprise

Drift should be treated as a normal operational concern, not a rare exceptional event.

Scheduled reevaluation is how the product stays honest when models and routing behavior evolve.

### Obsolete review is strategic product hygiene

Not every skill should live forever.

This epic should make it operationally normal to say:

- this skill still helps
- this skill barely helps
- this skill should be narrowed
- this skill should be merged
- this skill should be retired

### Team-facing surfaces should be useful, not decorative

The read surfaces should prioritize:

- clarity
- evidence
- history
- actionability

not:

- flashy dashboards with weak substance
- aesthetic polish at the expense of operational value

---

## Validation and Acceptance Gates

Epic 10 is only complete if all of the following are true:

- a team-facing read surface exists
- experiment and recommendation history are visible
- starter eval packs exist and validate
- integration/API surfaces exist where intended
- scheduled reevaluation exists
- obsolete-review workflow exists
- operational docs exist
- the full system now feels like a real team-operable product
- post-v1 next steps are documented explicitly

---

## Evidence Required for Closeout

At closeout, capture:

- dashboard/read-surface paths
- history-view paths
- eval pack paths
- API/integration surface paths
- scheduled reevaluation paths
- obsolete-review workflow paths
- screenshots or equivalent output evidence
- test outputs
- docs path(s)
- Epic 10 AAR path
- post-v1 roadmap path

---

## Risks and Edge Cases

### Dashboard becomes a vanity layer

If the team-facing product looks nice but does not expose real evidence or history, it will feel hollow fast.

### Eval packs become rigid templates nobody trusts

If packs are too generic or poorly documented, they will not become a real adoption lever.

### Drift reevaluation exists but is not actionable

Scheduled reevaluation must lead to understandable outcomes, not just more data exhaust.

### Obsolete-review is surfaced but no one knows what to do next

The operational workflow matters as much as the label.

### Team/API surfaces fork logic from CLI/CI

That would create multiple truths and weaken the product.

---

## Claude Code Execution Notes

When Claude Code works this epic, it should:

- verify Epics 01-09 landed correctly before starting
- inspect any existing dashboard/eval-pack/ops work before adding new work
- build team surfaces on top of canonical evidence, not parallel logic
- keep eval packs useful and inspectable
- treat drift as a normal operating workflow
- make obsolete-review operationally meaningful
- produce a durable end-of-epic AAR
- write a clear post-v1 roadmap at the end

### Mandatory workflow reminders

- verify prior epic first
- check comments/fixes if this is a follow-up pass
- run a repo sweep when relevant
- do not drift into generic platform sprawl
- do not sacrifice operational clarity for UI vanity

---

## Suggested Branch / Commit / PR Discipline

### Branch

`feature/epic-10-team-product-eval-packs-and-drift-operations`

### Commit style

- `feat(epic-10): add initial team-facing read surface`
- `feat(epic-10): add experiment and recommendation history views`
- `feat(epic-10): add starter eval packs`
- `feat(epic-10): add team integration or api surfaces`
- `feat(epic-10): add scheduled drift reevaluation workflows`
- `feat(epic-10): add obsolete-review workflow`
- `test(epic-10): add team product and drift operations coverage`
- `docs(epic-10): document team operations and eval pack usage`
- `docs(epic-10): add epic 10 aar and post-v1 roadmap`

### PR title

`[EPIC 10] Team product, eval packs, and drift operations`

---

## AAR Requirements

The Epic 10 AAR must include:

### What shipped

- team-facing read surface completed
- history views completed
- starter eval packs completed
- integration/API surfaces completed
- scheduled reevaluation completed
- obsolete-review workflow completed
- docs and tests completed

### Evidence

- screenshots or equivalent outputs of team-facing views
- sample experiment history view
- sample recommendation history view
- eval pack examples
- drift reevaluation examples
- obsolete-review example
- docs paths
- test outputs

### Open risks

- any team-surface rough edges
- any eval-pack categories still thin
- any drift/ops workflows likely to need strengthening post-v1

### Post-v1 roadmap should include

- next product hardening priorities
- highest-value UX improvements
- team/admin/reporting improvements
- broader integration opportunities still within the Claude Skill niche
- deferred live-mode/runtime enhancements if still relevant

---

## Reference Note for Beads

Every Epic 10 bead should reference this file.

Suggested annotation line:

`Reference doc: 000-docs/epics/epic-10-team-product-eval-packs-and-drift-operations.md`

Suggested instruction line:

`This task is governed by the epic reference doc above. Follow its scope, dependencies, acceptance gates, evidence requirements, and out-of-scope constraints.`
