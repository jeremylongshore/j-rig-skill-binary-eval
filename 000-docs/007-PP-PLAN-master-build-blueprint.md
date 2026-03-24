# J-Rig Binary Eval -- Master Build Blueprint
**Author:** Jeremy Longshore -- Intent Solutions
**Date:** 2026-03-24
**Status:** Canonical build blueprint
**Product Shape:** Claude-native eval, regression-gating, and optimization engine
**Primary Ecosystem:** Claude Code, Claude Skills, `SKILL.md`, skill packs, plugin bundles, private skill libraries, marketplace-style skill catalogs

---

# 0. Blueprint Purpose

This document is the canonical planning reference for building **J-Rig Binary Eval**.

It is intended to serve four roles at once:

1. **Master product blueprint**
2. **Phase/epic planning document**
3. **Beads reference and decomposition guide**
4. **Claude Code execution prompt source**

This document should be treated as durable source-of-truth planning material.

---

# 1. Product Definition

## 1.1 What J-Rig Binary Eval Is

J-Rig Binary Eval is an **evaluation harness and rollout gate for Claude Skills**.

It is a focused system that treats `SKILL.md` artifacts as production software rather than markdown documents that get shipped on instinct.

For every new or changed Claude Skill, J-Rig Binary Eval should determine:

1. Does it package correctly?
2. Does it trigger when it should?
3. Does it avoid triggering when it should not?
4. Does it perform its intended task correctly?
5. Did this version improve without breaking previously working behavior?
6. Does the skill still add value versus the current base model?
7. Is the rollout safe?

## 1.2 What J-Rig Binary Eval Is Not

J-Rig Binary Eval is not:

- a generic eval dashboard for all AI outputs
- a broad agent observability suite
- a fuzzy quality score machine
- a vague prompt-improvement playground
- a cross-model eval product for every ecosystem

It is **controlled release infrastructure for Claude Skills**.

## 1.3 Core Product Thesis

Claude Skills need software-grade release discipline.

That means:

- explicit eval contracts
- binary criteria
- external evaluators
- observed-behavior grading
- regression gating
- baseline/no-skill comparison
- model-aware testing
- evidence-backed ship decisions

---

# 2. Non-Negotiable Design Principles

## 2.1 Criteria Must Be Binary

If a criterion cannot be answered yes or no, it is not ready.

Bad:
- "Is this good?"
- "Does this sound better?"
- "Is this compelling?"

Good:
- "Does the skill trigger on this obvious request?"
- "Does the skill avoid triggering on this unrelated request?"
- "Does the output include the required section?"
- "Does the output avoid banned content?"
- "Does the observed artifact match the expected format?"

## 2.2 The Evaluator Must Be Separate

The skill under test must never be the final judge of itself.

J-Rig Binary Eval must use:

- deterministic checks where possible
- external LLM judges for semantic evaluation
- optional human review only when needed

## 2.3 Observed Behavior Outranks Claimed Behavior

The product should not merely grade the transcript or self-description.

It should grade:

- what was produced
- what artifact was created
- what actually happened in the harness
- whether the observed outcome matches the contract

## 2.4 Regression Tests Are Sacred

If a change improves average score but breaks a sacred regression case, the change is rejected.

## 2.5 One Change at a Time

The optimizer may only propose one interpretable atomic change per experiment.

## 2.6 Blockers Block Release

A blocker failure cannot be "averaged out" by other successes.

## 2.7 Baseline Value Matters

If the base model already performs the task at nearly the same quality without the skill, the skill should be flagged for obsolete review.

## 2.8 Model-Aware Testing Is Required

Haiku, Sonnet, and Opus may behave differently. That difference is product reality, not noise.

---

# 3. Product Surfaces

J-Rig Binary Eval must score these seven surfaces:

## 3.1 Package Integrity
Checks such as:
- `SKILL.md` exists
- frontmatter parses
- required metadata present
- description is specific enough
- referenced files exist
- examples are present where needed
- structure is coherent

## 3.2 Trigger Quality
Measures:
- trigger precision
- trigger recall
- false-positive rate
- paraphrase coverage
- ambiguous-case handling
- sibling confusion
- pack-level overlap

## 3.3 Functional Quality
Checks:
- required structure
- task completion
- instruction adherence
- artifact completeness
- banned output avoidance
- deterministic format validation
- judge-based semantic quality

## 3.4 Regression Protection
Measures:
- newly passing cases
- newly failing cases
- blocker regressions
- sacred regressions
- pack-level confusion regressions

## 3.5 Baseline Value
Compares:
- skill-on performance
- skill-off performance
- optional golden-version performance

Possible outcomes:
- keep
- simplify
- narrow
- merge
- obsolete-review

## 3.6 Model Variance
Tracks by model:
- trigger rate
- functional pass rate
- blocker failures
- latency
- token/cost impact
- cheapest acceptable model

## 3.7 Rollout Safety
Checks:
- prompt leakage risk
- unsafe triggering
- overreach beyond scope
- tool misuse
- malicious prompt sensitivity
- unsafe sibling interference
- dangerous automation pathways

---

# 4. Core Architecture

J-Rig Binary Eval uses a seven-layer architecture.

## 4.1 Spec Layer
Human-authored YAML definitions:
- eval specs
- eval contracts
- criteria
- test cases
- sibling context

## 4.2 Execution Layer
Runs the skill against:
- trigger cases
- functional cases
- regression cases
- adversarial cases
- baseline/no-skill cases

## 4.3 Observation Layer
Captures:
- outputs
- artifacts
- cost
- latency
- timing
- observed outcomes
- extracted artifact content

## 4.4 Judgment Layer
Implements:
- deterministic checks first
- external LLM judge second
- calibration
- disagreement handling
- human review only when necessary

## 4.5 Optimization Layer
Handles:
- failure clustering
- weakest-criterion targeting
- single atomic changes
- experiment runs
- accept/reject/revert logic
- early stopping
- resistant-case surfacing

## 4.6 Evidence Layer
Stores:
- runs
- scores
- artifacts
- diffs
- regressions
- experiments
- baselines
- launch reports

## 4.7 UI / API / CLI Layer
Provides:
- local CLI author workflows
- PR/CI workflows
- team reporting later
- dashboard later

---

# 5. Canonical Data Model

Core entities:

- `skills`
- `skill_versions`
- `eval_specs`
- `eval_contracts`
- `criteria`
- `test_cases`
- `runs`
- `observed_outcomes`
- `outputs`
- `criterion_results`
- `experiments`
- `regressions`
- `baselines`
- `launch_reports`

---

# 6. Production Tech Stack

## 6.1 Runtime
- TypeScript
- Node.js 20+
- pnpm

## 6.2 CLI / parsing / terminal UX
- `commander`
- `@clack/prompts`
- `picocolors`
- `yaml`
- `unified`
- `remark-parse`
- `remark-frontmatter`

## 6.3 Validation / schema / core enforcement
- `zod`

## 6.4 Anthropic integration
- `@anthropic-ai/sdk`

## 6.5 Concurrency / retry
- `p-limit`
- `async-retry`

## 6.6 Persistence
- `better-sqlite3`
- `drizzle-orm`

## 6.7 Artifact extraction
- `pdf-parse`
- `mammoth`

## 6.8 Future live-mode execution
- `execa`

## 6.9 Dashboard layer
- `next.js`
- `tailwindcss`
- `shadcn/ui`

---

# 7. How This System Should Be Used

## 7.1 Local Author Workflow

A skill author should be able to run:

```bash
jrig init
jrig run .
jrig compare previous current
```

And get:
- package validation
- trigger results
- functional results
- baseline comparison
- regressions
- cost estimate
- launch recommendation

## 7.2 CI / PR Workflow

A PR touching a skill should run:

```bash
jrig ci --changed-only
```

And produce:
- blocker summary
- criterion report
- regressions introduced
- baseline delta
- model matrix
- ship / warn / block recommendation

## 7.3 Marketplace Workflow

A submitted skill should require:
- SKILL.md
- eval spec
- eval contract
- minimum test set
- no blocker failures
- acceptable pack-confusion metrics

## 7.4 Org Skill Library Workflow

Internal skill libraries should require:
- package validation
- trigger thresholds
- no blocker regressions
- model-aware pass thresholds
- archived evidence
- scheduled drift reevaluation

---

# 8. Global Engineering and Process Rules

These rules apply to every phase.

## 8.1 Repo Rules
- repo-local git only
- repo-local Beads only
- clear workspace boundaries
- durable docs checked in
- evidence stored in predictable locations

## 8.2 Phase Rules

Before starting a new phase:
- verify the prior phase landed correctly
- review comments / requested fixes
- resolve follow-up issues
- run a repo-wide sweep when relevant

After finishing a phase:
- produce an end-of-phase AAR
- capture evidence
- update docs
- update Beads
- note inherited risks for the next phase

## 8.3 Branch Discipline

Suggested branch naming:

```
feature/phase-01-repo-foundation
feature/phase-02-spec-contract-system
feature/phase-03-package-deterministic
feature/phase-04-evidence-persistence
feature/phase-05-trigger-harness
feature/phase-06-functional-observation
feature/phase-07-judgment-calibration-models
feature/phase-08-regression-baseline-cli-ci
feature/phase-09-optimizer-experiments
feature/phase-10-team-product-eval-packs-drift
```

## 8.4 Commit Discipline

Suggested commit prefixes:
- `feat(phase-0N): ...`
- `fix(phase-0N): ...`
- `test(phase-0N): ...`
- `docs(phase-0N): ...`
- `refactor(phase-0N): ...`

## 8.5 PR Discipline

Suggested PR titles:
- `[PHASE 01] Repo foundation and operating standard`
- `[PHASE 02] Spec layer and contract system`
- etc.

---

# 9. Phase Overview

The product is broken into ten phases. Each phase is treated as one top-level epic. Each epic is decomposed into granular child beads.

1. Phase 1 -- Repo Foundation and Operating Standard
2. Phase 2 -- Spec Layer and Contract System
3. Phase 3 -- Package Integrity and Deterministic Checks
4. Phase 4 -- Evidence Layer, Persistence, and Run Lifecycle
5. Phase 5 -- Trigger Harness and Skill Roster Simulation
6. Phase 6 -- Functional Execution Harness and Observation Layer
7. Phase 7 -- Judgment Layer, Calibration, and Model Matrix
8. Phase 8 -- Regression, Baseline, Scoring, CLI, and CI Gate
9. Phase 9 -- Optimizer and Experiment Engine
10. Phase 10 -- Team Product, Eval Packs, and Drift Operations

---

# 10. Phase 1 -- Repo Foundation and Operating Standard

**Status:** PARTIALLY COMPLETE (governance layer done via /repo-dress; TypeScript/pnpm workspace pending)

## 10.1 Intent

Establish the repo, workspace, engineering standards, startup pipeline, docs, and Beads scaffolding so all later work sits on a stable base.

## 10.2 Why This Phase Exists

Without this phase:
- later work will drift structurally
- docs and code will diverge
- package/workspace boundaries will become messy
- Beads tracking will start late and become less useful

## 10.3 In Scope
- initialize repo structure
- set up pnpm workspace
- set up TypeScript base config
- set up lint/format/test baseline
- create initial README
- create repo-level CLAUDE.md
- create planning docs
- initialize repo-local Beads
- define branch/PR/commit conventions

## 10.4 Out of Scope
- full core engine
- Anthropic API integration
- eval execution
- optimizer logic
- dashboard

## 10.5 Child Beads

**P1.1 Repo bootstrap** -- COMPLETE
- initialize repo
- configure workspace root
- create package directories
- establish naming conventions

**P1.2 TypeScript and pnpm foundation** -- TODO
- root package.json
- pnpm-workspace.yaml
- tsconfig.json
- shared scripts and workspace tasks

**P1.3 Quality baseline** -- TODO
- linting
- formatting
- test runner baseline
- pre-commit / local validation scripts if desired

**P1.4 Docs and standards pack** -- COMPLETE
- README
- CLAUDE.md
- architecture/planning docs
- phase tracking docs

**P1.5 Repo-local Beads initialization** -- COMPLETE
- initialize Beads
- create top-level phase epics
- create child task placeholders
- document task workflow

**P1.6 Phase 1 evidence and closeout** -- TODO
- verify repo structure
- verify workspace scripts
- verify docs existence
- capture closeout evidence and AAR

## 10.6 Acceptance Criteria
- repo bootstraps cleanly
- pnpm install works
- base scripts run
- docs are present
- Beads is initialized and populated
- Phase 1 AAR exists

## 10.7 Claude Code Prompt -- Phase 1

```
We are implementing Phase 1 of J-Rig Binary Eval: Repo Foundation and Operating Standard.

Context:
- This repo is for J-Rig Binary Eval, a Claude-native evaluation harness and rollout gate for Claude Skills.
- The stack is TypeScript + Node 20 + pnpm workspaces.
- The product must remain CLI-first early, with dashboard later.
- Repo-local git and repo-local Beads are required.
- We want clean package boundaries and durable docs from day one.
- Governance layer (README, CLAUDE.md, LICENSE, CI/CD, etc.) is already in place via /repo-dress.

Your job:
1. Verify existing repo structure and governance files.
2. Set up pnpm workspace with package directories (cli/, core/, db/, dashboard/).
3. Set up TypeScript base configuration.
4. Set up lint/format/test baseline.
5. Create Beads epics for all 10 phases with child task placeholders.
6. Produce evidence and a closeout report.

Deliverables:
- pnpm workspace setup with package scaffold
- TypeScript configuration
- lint/format/test baseline
- Beads populated with phase epics and child placeholders
- proof that install/lint/test baseline works

Constraints:
- Keep the repo clean and minimal.
- Do not jump ahead into later phases.
- Do not build product logic yet.
- Document what you changed and why.
- End with a concise AAR and explicit list of next inherited tasks.
```

---

# 11. Phase 2 -- Spec Layer and Contract System

## 11.1 Intent

Define the schema, structure, validation, and parsing rules for eval specs and eval contracts.

## 11.2 Why This Phase Exists

This is the formal language of the product.
If the spec and contract model are sloppy, the rest of the system will be sloppy.

## 11.3 In Scope
- YAML spec schema
- eval contract schema
- criterion schema
- test case schema
- sibling context schema
- parser + validator
- human-friendly diagnostics
- golden valid/invalid examples

## 11.4 Out of Scope
- actual trigger execution
- full functional runner
- optimization
- dashboard

## 11.5 Child Beads

P2.1 Eval spec schema design

Define the structure for:
- metadata
- criteria
- context
- test sets
- thresholds

P2.2 Eval contract schema design

Define the structure for:
- purpose
- should-trigger cases
- should-not-trigger cases
- blockers
- evidence rules
- safety rules
- baseline expectations

P2.3 Criterion and test case schema

Support:
- deterministic
- judge-based
- blocker
- weighted
- baseline-sensitive
- pack-sensitive
- regression-critical

P2.4 YAML parsing and validation engine

Implement parser and validator with rich errors.

P2.5 SKILL.md frontmatter/body parsing

Use AST parsing, not regex hacks.

P2.6 Golden examples and invalid fixtures

Create representative examples for:
- valid spec
- invalid spec
- malformed contract
- broken criterion definitions

P2.7 Phase 2 evidence and closeout

Capture validation outputs and documentation.

## 11.6 Acceptance Criteria
- valid specs parse
- invalid specs fail with useful errors
- contracts are enforced
- SKILL.md parsing is stable
- schema tests exist
- sample fixtures exist

## 11.7 Claude Code Prompt -- Phase 2

```
We are implementing Phase 2 of J-Rig Binary Eval: Spec Layer and Contract System.

Goal:
Build the formal schema and parsing layer for eval specs and eval contracts.

Requirements:
- Use TypeScript and Zod for schema enforcement.
- Parse YAML specs cleanly with strong validation.
- Parse SKILL.md safely using markdown/frontmatter tooling rather than fragile regex.
- Separate eval spec concerns from eval contract concerns, but ensure they compose cleanly.
- Build human-friendly diagnostics with enough detail that authors can fix broken files quickly.

Deliverables:
- eval spec schema
- eval contract schema
- criterion schema
- test case schema
- parser/validator utilities
- SKILL.md parsing utilities
- valid/invalid fixtures
- tests
- docs describing author expectations

Constraints:
- Do not jump into execution harness work yet.
- Keep the schema explicit and future-proof.
- Prefer strong validation over permissive parsing.
- End with a phase report including open design tensions that later phases inherit.
```

---

# 12. Phase 3 -- Package Integrity and Deterministic Checks

## 12.1 Intent

Build the zero-API-cost validation engine that catches cheap failures early.

## 12.2 Why This Phase Exists

You should not spend model calls on a skill that:
- is missing files
- has bad frontmatter
- has broken references
- is obviously underspecified
- violates simple packaging constraints

## 12.3 In Scope
- package integrity checker
- deterministic check registry
- description heuristics
- reference/file existence checks
- simple size/structure checks
- deterministic reporting

## 12.4 Out of Scope
- trigger simulation
- functional execution
- LLM judges
- optimizer

## 12.5 Child Beads

P3.1 Package checker engine

Core package validation framework.

P3.2 Deterministic criterion registry

Support checks like:
- contains
- not-contains
- regex
- JSON validity
- cost threshold placeholder
- latency threshold placeholder

P3.3 Description quality heuristics

Check:
- vague descriptions
- specificity patterns
- third-person guidance if used
- under-documented skills

P3.4 Referenced asset validation

Ensure referenced files exist and are coherent.

P3.5 Oversized/underspecified detection

Line count, missing examples, suspiciously thin specs.

P3.6 Deterministic reporting output

Human-readable and machine-readable results.

P3.7 Phase 3 evidence and closeout

## 12.6 Acceptance Criteria
- zero-API-cost checks run end to end
- broken packages fail clearly
- deterministic results are stored and surfaced
- tests cover typical invalid package patterns

## 12.7 Claude Code Prompt -- Phase 3

```
We are implementing Phase 3 of J-Rig Binary Eval: Package Integrity and Deterministic Checks.

Goal:
Build the zero-API-cost validation layer that prevents wasting model calls on obviously broken skill packages.

Focus:
- package integrity
- deterministic criteria
- description quality heuristics
- referenced file validation
- lightweight structure checks
- clear reporting

Requirements:
- This must be fast, local, and reliable.
- Broken package structure should fail before any expensive eval step.
- Reporting must be useful to both CLI users and future CI consumption.

Deliverables:
- package checker engine
- deterministic check registry
- description heuristics
- referenced file existence checks
- tests
- docs
- evidence of deterministic runs

Constraints:
- Keep this phase self-contained.
- Do not jump ahead into trigger or functional harness logic.
- End with a report describing what failures are now caught cheaply and what still requires model-backed evaluation.
```

---

# 13. Phase 4 -- Evidence Layer, Persistence, and Run Lifecycle

## 13.1 Intent

Define how runs are stored, how artifacts are persisted, and how the system remembers what happened.

## 13.2 Why This Phase Exists

Without persistence:
- regressions cannot be compared reliably
- experiments have no memory
- baselines are hard to track
- launch decisions are not auditable

## 13.3 In Scope
- database schema
- SQLite integration
- run lifecycle model
- artifact/output storage
- evidence serialization
- readback/query utilities

## 13.4 Out of Scope
- dashboard UI
- optimizer
- advanced team APIs

## 13.5 Child Beads

P4.1 Database schema design

Runs, outputs, criteria, baselines, regressions, experiments.

P4.2 SQLite persistence layer

Implement repo-local database.

P4.3 Run lifecycle model

Statuses such as:
- pending
- running
- completed
- failed
- timed_out
- blocked

P4.4 Artifact and output storage layout

Filesystem strategy for raw outputs and extracted artifacts.

P4.5 Evidence serialization

Stable JSON/Markdown evidence outputs.

P4.6 Query/readback utilities

Needed for compare, CI, and future UI.

P4.7 Phase 4 evidence and closeout

## 13.6 Acceptance Criteria
- runs persist
- outputs persist
- artifacts persist
- evidence can be read back
- compare-ready storage exists

## 13.7 Claude Code Prompt -- Phase 4

```
We are implementing Phase 4 of J-Rig Binary Eval: Evidence Layer, Persistence, and Run Lifecycle.

Goal:
Create the persistence model and evidence layer so that every run becomes durable, inspectable, and comparable.

Requirements:
- Use SQLite first.
- Keep the storage local and zero-config.
- Store both structured records and file-based artifacts.
- Design the model so later PostgreSQL migration is realistic without rewriting core logic.
- Make run lifecycle states explicit.
- Evidence should be usable by CLI, CI, compare flows, and later dashboard work.

Deliverables:
- DB schema
- persistence implementation
- run lifecycle model
- filesystem artifact layout
- serialization utilities
- readback/query helpers
- tests
- docs

Constraints:
- Do not add dashboard work yet.
- Avoid over-engineering a distributed system.
- End with example persisted runs and a short explanation of how future phases will consume them.
```

---

# 14. Phase 5 -- Trigger Harness and Skill Roster Simulation

## 14.1 Intent

Build the trigger evaluation system that simulates skill routing and measures when a skill should or should not activate.

## 14.2 Why This Phase Exists

A skill that triggers incorrectly is broken even if its body is beautifully written.

## 14.3 In Scope
- available skill roster builder
- sibling context handling
- trigger simulation runner
- precision/recall metrics
- confusion analysis
- trigger test case support

## 14.4 Out of Scope
- full functional skill execution
- optimizer
- team dashboard

## 14.5 Child Beads

P5.1 Available skills builder

Construct routing context from:
- target skill
- sibling skills
- metadata

P5.2 Sibling context model

Support pack/library-aware testing.

P5.3 Trigger runner

Ask evaluator which skill should fire or none.

P5.4 Trigger metrics engine

Compute:
- precision
- recall
- false positives
- false negatives
- ambiguity

P5.5 Confusion analysis

Detect overlap pairs and pack-level risk.

P5.6 Trigger test case format

Support:
- should-trigger
- should-not-trigger
- ambiguous
- context-dependent

P5.7 Phase 5 evidence and closeout

## 14.6 Acceptance Criteria
- trigger cases run
- should-trigger and should-not-trigger are measured
- sibling confusion is surfaced
- trigger results are stored as evidence

## 14.7 Claude Code Prompt -- Phase 5

```
We are implementing Phase 5 of J-Rig Binary Eval: Trigger Harness and Skill Roster Simulation.

Goal:
Build the trigger evaluation system that estimates whether Claude would select the correct skill, the wrong skill, multiple possible skills, or none.

Requirements:
- Simulate routing using the target skill plus sibling skills when applicable.
- Support positive, negative, ambiguous, and context-dependent trigger cases.
- Measure trigger precision and recall, not just raw hit rate.
- Treat pack-level confusion as a first-class output.

Deliverables:
- available skill roster builder
- sibling context support
- trigger runner
- trigger metrics engine
- confusion analysis
- tests
- docs
- evidence examples

Constraints:
- Be honest about approximation limits.
- Do not pretend this perfectly replicates Claude Code internals.
- Still make the system strong enough for relative comparison and rollout gating.
- End with a report showing trigger evaluation on realistic sample skills.
```

---

# 15. Phase 6 -- Functional Execution Harness and Observation Layer

## 15.1 Intent

Simulate skill invocation, capture outputs and artifacts, and observe what the skill actually does.

## 15.2 Why This Phase Exists

Static inspection is not enough.
The product must test the skill in action.

## 15.3 In Scope
- skill invocation simulator
- skill body injection
- context/base path support
- artifact capture
- artifact extraction/post-processing
- observed outcome model
- timeout/cost/latency observation

## 15.4 Out of Scope
- optimizer
- dashboard
- live-mode full runtime execution

## 15.5 Child Beads

P6.1 Skill invocation simulator

Model skill execution in API simulation mode.

P6.2 Context and file injection

Provide base path and relevant local file content when needed.

P6.3 Artifact capture pipeline

Capture outputs and produced artifacts.

P6.4 Artifact extractors

Support text extraction from:
- PDF
- DOCX
- plain structured outputs

P6.5 Observed outcome model

Store what happened, not just what the assistant claimed.

P6.6 Time/cost/latency capture

Needed for operational eval surfaces.

P6.7 Phase 6 evidence and closeout

## 15.6 Acceptance Criteria
- simulated functional runs work
- artifacts are captured and extracted
- observed outcomes are stored
- execution metadata is preserved

## 15.7 Claude Code Prompt -- Phase 6

```
We are implementing Phase 6 of J-Rig Binary Eval: Functional Execution Harness and Observation Layer.

Goal:
Move from static package/trigger analysis into actual simulated skill execution with observed output grading inputs.

Requirements:
- Simulate skill invocation in a reproducible way.
- Capture outputs, artifacts, latency, and cost.
- Support file-producing skills as first-class cases.
- Grade later phases on observed outcomes rather than self-reported success.

Deliverables:
- invocation simulator
- context injection support
- artifact capture
- artifact extraction
- observed outcome records
- timing/cost capture
- tests
- docs
- stored example runs

Constraints:
- Phase 1 of execution may be API-simulated only.
- Be explicit about limitations for tool-heavy or live-runtime-dependent skills.
- End with examples showing the harness on at least one text-oriented skill and one artifact-oriented skill.
```

---

# 16. Phase 7 -- Judgment Layer, Calibration, and Model Matrix

## 16.1 Intent

Build the external evaluator layer, calibration flows, disagreement handling, and model-aware evaluation.

## 16.2 Why This Phase Exists

This is where the product becomes a real harness rather than a transcript collector.

## 16.3 In Scope
- binary judge engine
- strict output parsing
- judge prompt variants
- calibration/golden cases
- disagreement handling
- model matrix runner
- per-model reporting

## 16.4 Out of Scope
- optimizer
- dashboard
- broad human review system beyond minimal queueing

## 16.5 Child Beads

P7.1 Binary judge engine

Judge returns only:
- yes
- no
- unsure
with short evidence.

P7.2 Strict parsing and validation

Validate judge outputs with Zod.

P7.3 Judge prompt rotation

Prevent overfitting to one phrasing.

P7.4 Calibration/golden set workflow

Check judge stability before critical runs.

P7.5 Disagreement and unsure flow

Handle judge uncertainty and mismatch.

P7.6 Model matrix runner

Run evals across Haiku, Sonnet, Opus as configured.

P7.7 Phase 7 evidence and closeout

## 16.6 Acceptance Criteria
- external judge works
- judge output is strictly validated
- calibration exists
- model matrix results are recorded
- disagreement handling exists

## 16.7 Claude Code Prompt -- Phase 7

```
We are implementing Phase 7 of J-Rig Binary Eval: Judgment Layer, Calibration, and Model Matrix.

Goal:
Build the external evaluator system that turns observed outcomes into controlled yes/no/unsure judgments with calibration and model-aware reporting.

Requirements:
- The evaluator must be separate from the skill under test.
- Judge outputs must be strict, machine-readable, and validated.
- Add calibration/golden case checking so results are not blindly trusted.
- Support per-model evaluation and reporting across Haiku, Sonnet, and Opus where configured.
- Add disagreement/unsure handling rather than forcing fake certainty.

Deliverables:
- binary judge engine
- strict schema parsing
- prompt rotation support
- calibration flow
- disagreement handling
- model matrix runner
- tests
- docs
- evidence runs

Constraints:
- Keep outputs concise and structured.
- Avoid essay-style judge responses.
- End with examples showing calibration, per-model results, and disagreement behavior.
```

---

# 17. Phase 8 -- Regression, Baseline, Scoring, CLI, and CI Gate

## 17.1 Intent

Turn raw evaluation results into actionable ship/no-ship recommendations with regression protection, baseline comparison, CLI workflows, and PR gating.

## 17.2 Why This Phase Exists

Without this phase, the system measures things but does not govern releases.

## 17.3 In Scope
- regression compare engine
- sacred regression logic
- baseline/no-skill compare
- scoring aggregation
- launch recommendation logic
- CLI commands
- CI/PR gating

## 17.4 Out of Scope
- optimizer
- dashboard UI

## 17.5 Child Beads

P8.1 Regression compare engine

Compare before/after runs.

P8.2 Sacred regression enforcement

Block release on sacred failures.

P8.3 Baseline/no-skill compare engine

Measure whether the skill still adds value.

P8.4 Scoring aggregation

Weighted score + blocker logic + thresholds.

P8.5 Launch recommendation engine

Return:
- pass
- warn
- block
- obsolete-review

P8.6 CLI commands

Implement:
- init
- run
- compare
- ci

P8.7 GitHub Actions PR gate

Run on changed skills and post results.

P8.8 Phase 8 evidence and closeout

## 17.6 Acceptance Criteria
- compare flow works
- baseline compare works
- CLI commands are usable
- CI blocks blocker failures
- recommendations are deterministic and documented

## 17.7 Claude Code Prompt -- Phase 8

```
We are implementing Phase 8 of J-Rig Binary Eval: Regression, Baseline, Scoring, CLI, and CI Gate.

Goal:
Turn evaluation data into actual release governance.

Requirements:
- Compare runs and detect regressions.
- Treat sacred regressions and blocker failures as release blockers.
- Add baseline/no-skill comparisons.
- Aggregate scores in a transparent, documented way.
- Expose local CLI workflows.
- Expose PR/CI gating workflows.

Deliverables:
- regression compare engine
- sacred regression enforcement
- baseline compare engine
- scoring aggregation logic
- recommendation engine
- CLI commands
- GitHub Actions integration
- tests
- docs
- example PR-style outputs

Constraints:
- Keep the recommendation logic explainable.
- No black-box score magic.
- End with evidence showing a blocked case, a warned case, and a passing case.
```

---

# 18. Phase 9 -- Optimizer and Experiment Engine

## 18.1 Intent

Build the single-change optimizer that improves skills without breaking sacred constraints.

## 18.2 Why This Phase Exists

This phase turns J-Rig Binary Eval from a gate into an improvement engine.

## 18.3 In Scope
- failure clustering
- weakest-criterion targeting
- structured change proposal engine
- experiment runner
- accept/reject/revert logic
- early stopping
- resistant-case surfacing

## 18.4 Out of Scope
- broad autonomous rewrite systems
- giant multi-agent orchestration for its own sake

## 18.5 Child Beads

P9.1 Failure clustering

Group related failures and isolate likely root causes.

P9.2 Weakest-criterion targeting

Pick the next problem intentionally.

P9.3 Structured change proposal engine

Only allow one atomic change type at a time.

P9.4 Experiment runner

Run full suites against proposed change.

P9.5 Accept/reject/revert logic

Keep only safe improvements.

P9.6 Early stopping and resistant-case detection

Prevent infinite loop theater.

P9.7 Phase 9 evidence and closeout

## 18.6 Acceptance Criteria
- optimizer proposes one change at a time
- experiment runs are persisted
- regressions trigger revert
- resistant cases are surfaced cleanly

## 18.7 Claude Code Prompt -- Phase 9

```
We are implementing Phase 9 of J-Rig Binary Eval: Optimizer and Experiment Engine.

Goal:
Build a controlled single-change optimizer that can improve a skill while respecting blockers, sacred regressions, sibling-pack constraints, and baseline value.

Requirements:
- Cluster failures first.
- Target the weakest criterion intentionally.
- Propose exactly one atomic change at a time.
- Run the full relevant suite for each experiment.
- Accept only safe improvements.
- Revert regressions automatically.
- Stop after repeated failed attempts and surface resistant cases.

Deliverables:
- failure clustering
- weakest-criterion selection
- structured change proposal engine
- experiment runner
- accept/reject/revert logic
- early stopping
- resistant-case surfacing
- tests
- docs
- evidence from successful and rejected experiments

Constraints:
- Keep optimization interpretable.
- Do not allow uncontrolled multi-change edits.
- End with examples showing one accepted experiment and one rejected/reverted experiment.
```

---

# 19. Phase 10 -- Team Product, Eval Packs, and Drift Operations

## 19.1 Intent

Turn the system into a team-ready product with dashboard/reporting, reusable eval packs, and scheduled reevaluation.

## 19.2 Why This Phase Exists

This is where J-Rig Binary Eval becomes operational infrastructure rather than a local power tool.

## 19.3 In Scope
- Next.js dashboard
- shared org/team reporting
- experiment history UI
- initial eval packs
- marketplace/org integration hooks
- scheduled drift reevaluation
- obsolete review workflow

## 19.4 Out of Scope
- every possible integration
- generic non-Claude expansion

## 19.5 Child Beads

P10.1 Dashboard foundation

Build team-facing read/report UI.

P10.2 Experiment history UI

Show what changed, why, and what happened.

P10.3 Starter eval packs

Ship initial packs for:
- document creation
- code generation
- data analysis
- workflow orchestration
- safety-sensitive skills

P10.4 Org/team API surface

Support shared workflows.

P10.5 Marketplace/org integration hooks

Submission/approval/report pathways.

P10.6 Drift reevaluation scheduler

Periodic reruns after model changes.

P10.7 Obsolete review workflow

Handle skills overtaken by the base model.

P10.8 Phase 10 evidence and closeout

## 19.6 Acceptance Criteria
- dashboard works
- eval packs exist
- scheduled reevaluation exists
- obsolete-review path is visible
- org/team reporting is usable

## 19.7 Claude Code Prompt -- Phase 10

```
We are implementing Phase 10 of J-Rig Binary Eval: Team Product, Eval Packs, and Drift Operations.

Goal:
Turn the system into team-usable release infrastructure with reporting, reusable eval packs, and scheduled reevaluation.

Requirements:
- Add a dashboard for browsing runs, regressions, baselines, and experiments.
- Add reusable eval packs for common Claude Skill categories.
- Add team/org-oriented APIs or integration points where appropriate.
- Support periodic reevaluation after model changes.
- Surface obsolete-review workflows when base-model performance catches up.

Deliverables:
- dashboard foundation
- experiment history UI
- starter eval packs
- org/team integration points
- drift reevaluation scheduling
- obsolete-review workflow
- tests
- docs
- evidence showing the team-facing product in action

Constraints:
- Keep the scope focused on the Claude Skill ecosystem.
- Do not drift into a generic multi-ecosystem platform.
- End with a final phase report and a recommended post-v1 roadmap.
```

---

# 20. Beads Mapping Template

Use this template for each phase epic and each child bead.

## 20.1 Phase Epic Template

```
Title: Phase [N] -- [Title]
Type: Epic
Priority: P0/P1/P2
Status: todo/in_progress/done

Summary:
[One paragraph describing the phase.]

Acceptance:
- [criterion]
- [criterion]
- [criterion]

Dependencies:
- depends on: [prior phase IDs]
- blocks: [future phase IDs]

Evidence required:
- tests
- docs
- AAR
- CLI output / screenshots / logs
```

## 20.2 Child Bead Template

```
Title: P[N].[X] -- [Task title]
Type: Task
Priority: P0/P1/P2
Status: todo/in_progress/done

Purpose:
[Short explanation]

Scope:
- [item]
- [item]
- [item]

Acceptance:
- [criterion]
- [criterion]
- [criterion]

Dependencies:
- depends on: [IDs]
- blocks: [IDs]

Evidence:
- [artifact]
- [test]
- [report]
```

---

# 21. Dependency Story

## 21.1 Hard dependencies
- Phase 1 before everything
- Phase 2 before trigger or functional execution
- Phase 3 before model-backed evaluation
- Phase 4 before compare/regression/baseline flows
- Phase 5 before pack confusion and trigger metrics
- Phase 6 before observed-behavior judging
- Phase 7 before trustworthy blocker recommendations
- Phase 8 before release governance
- Phase 9 after compare/gating logic exists
- Phase 10 after core local system is real

## 21.2 Protection rules
- no optimizer before regression logic
- no dashboard before evidence model is stable
- no marketplace workflows before ship/no-ship recommendations are real
- no fancy orchestration before core harness truth exists

---

# 22. Final Positioning

## 22.1 One-line

J-Rig Binary Eval is the evaluation harness and rollout gate for Claude Skills.

## 22.2 Expanded

J-Rig Binary Eval validates, compares, and improves SKILL.md rollouts before they ship. It evaluates package quality, trigger quality, functional quality, regressions, baseline value, model variance, and rollout safety using an external evaluator and evidence-backed release gates.

## 22.3 Tagline

J-Rig Binary Eval. Nothing ships untested.
