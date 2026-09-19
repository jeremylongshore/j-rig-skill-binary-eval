# Generic Eval Suite Lifecycle

**Plan:** `IEP-EVAL-EVOLUTION-001`

**Bead:** `bd_000-projects-htjt.8.1`

**Status:** IMPLEMENTED on `feat/eval-substrate-suite-batch`
**Date:** 2026-08-01

## Purpose

`j-rig suite` is the generic one-command lifecycle over the existing raw-run,
balanced-sampling, named-Grader, and unified-report contracts. It makes an
arbitrary Task × Config matrix executable without replacing the existing
skill-specific `eval` or `eval-batch` commands.

## Manifest

The manifest is YAML and is validated as `j-rig/eval-suite/v1`:

```yaml
schema: j-rig/eval-suite/v1
id: answer-suite
version: "1"
tasks:
  - tasks/task-a.yaml
  - tasks/task-b.yaml
configs:
  - configs/model-a.yaml
  - configs/model-b.yaml
grader: graders/answer.yaml
target_n: 3
```

`tasks`, `configs`, and `grader` paths are resolved relative to the manifest,
not the caller's current directory. Each Task and Config must validate against
the existing generic contracts. Task and Config identities must be unique;
duplicate Cartesian cells are rejected before execution. Validation errors
name the exact field, such as `suite.configs.1`, and include the resolved path
when a referenced definition is malformed.

## Execution

```bash
j-rig suite ./suite.yaml \
  --db ./j-rig.db \
  --output-dir ./.j-rig/suites/answer-suite \
  --json
```

The command expands every Task × Config cell, retaining the Config's model as
an explicit sampling dimension. It calls the existing `runGenericEval` seam
for each planned sample, then calls the existing `runGrade` seam only for a
completed raw Run. `runner_error` and `timed_out` rows remain retained in the
raw ledger and are never converted into quality Grades.

Raw Run identity remains the complete
`Task × TaskVersion × Config × ConfigVersion × Model × sample_index` tuple. A
sealed identity is therefore read-only on a rerun. If a process is
interrupted after the audit marks a job `running`, the next invocation replays
that same identity safely. Harness failures receive a fresh sample index on a
later invocation, preserving the failure while allowing target N to be
reached.

The current implementation executes one planning wave per invocation and
records any remaining top-ups as `summary.pending`. This bounds repeated
failures while keeping the next invocation deterministic and resumable.

## Audit and report outputs

The default output directory is `.j-rig/suites/<suite-id>`:

```text
.j-rig/suites/<suite-id>/
  manifest.json
  report.json
  report.md
```

`manifest.json` uses the `j-rig/eval-suite/v1` schema and records:

- manifest, Task, Config, and Grader paths plus parsed identities;
- every Cartesian sampling cell and its target-N counts;
- each planned/attempted raw Run id, sample index, status, and reuse flag;
- immutable Grade ids, selector digest, verdict, and score;
- pending top-ups and completed/harness-failure/failed summaries;
- suite-scoped report paths and raw-run count.

`report.json` is `j-rig/suite-report/v1`. It wraps the existing
`j-rig/unified-report/v1` projection with suite id, manifest path, and the
raw-run id list. `report.md` renders the same report for terminal/review use.
The report is an unsigned local projection, not a rollout authorization.

## Compatibility and migration

The older surfaces remain supported:

- use `j-rig eval` for one hand-authored skill spec;
- use `j-rig eval-batch` for a skills-root batch and Evidence Bundle lineage;
- use `j-rig run`, `j-rig grade`, `j-rig sample-plan`, and `j-rig report` for
  individual generic substrate stages;
- use `j-rig migrate <dir>` to explicitly dry-run or rewrite legacy
  v0.1.0-draft Evidence Bundle fixtures.

Suite execution never silently migrates old evidence. This keeps the
skill-specific and generic provenance paths readable and separately auditable.

## Non-goals

- model-judge Graders, disagreement sampling, and dashboard publication remain
  downstream work;
- a generated or generic suite result is not automatically a rollout decision;
- runner failures are not quality failures and do not receive Grades;
- suite manifests do not mutate source Task, Config, Grader, or skill files.
