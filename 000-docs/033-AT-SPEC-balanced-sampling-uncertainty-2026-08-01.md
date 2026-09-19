# Balanced Execution Sampling and Uncertainty Contract

**Plan:** `IEP-EVAL-EVOLUTION-001`
**Bead:** `bd_000-projects-htjt.3`
**Status:** ACTIVE — implementation slice
**Date:** 2026-08-01

## Purpose

The raw Run ledger records individual attempts. This slice adds the planning
and measurement rules needed to make a run set statistically legible without
silently combining unlike populations.

Execution sampling and judge sampling are separate:

- execution sampling repeats the complete Task × Config × Model attempt;
- judge sampling repeats a Grader over an already captured Run and never spends
  another runner/model execution.

The existing skill-specific evaluator remains compatible. These APIs operate on
the generic `raw_runs` and selected immutable `grades` records.

## Sampling cell and target N

A sampling cell is the complete identity:

```yaml
task_id: answer-task
task_version: "1"
config_id: local-harness
config_version: "1"
model: fixture-model
```

`target_n` means successful completed Runs required for every cell. The planner
top-ups cells in round-robin passes. It assigns a fresh sample index after the
highest existing index, preserving raw Run idempotence and avoiding a retry
collision.

Existing statuses are counted as follows:

| Status | Counts toward target N | Planner behavior |
|---|---:|---|
| `completed` | Yes | Satisfies one execution slot |
| `pending`, `running` | Reserved | Prevents a duplicate in-flight slot |
| `runner_error`, `timed_out` | No | Retained for diagnosis; replaced by a fresh sample |

The resulting plan reports attempted, completed, active, harness-failure, and
planned counts per cell. A plan is resumable: after a worker seals another Run,
the next plan only schedules the remaining top-up jobs.

## CLI plan and batch surfaces

`j-rig sample-plan` makes the scheduler inspectable. `j-rig batch` consumes a
path-based suite manifest and executes the planned jobs in balanced passes:

```yaml
# sampling-manifest.yaml
cells:
  - task_id: answer-task
    task_version: "1"
    config_id: local-harness
    config_version: "1"
    model: fixture-model
```

```bash
j-rig sample-plan \
  --manifest ./sampling-manifest.yaml \
  --target-n 3 \
  --db ./j-rig.db \
  --json
```

Each returned job can still be executed by `j-rig run` with the corresponding
task, config, and sample index. A batch manifest provides those paths directly:

```yaml
target_n: 3
jobs:
  - task: ./tasks/answer-task.yaml
    config: ./configs/local-harness.yaml
```

```bash
j-rig batch \
  --manifest ./batch.yaml \
  --db ./j-rig.db \
  --json
```

Batch execution re-plans after the pass completes. Sealed successful Runs are
reused, active Runs reserve slots, and runner failures remain in the ledger but
are replaced by a fresh sample index on the next invocation. A batch never
calls a judge; grading remains a separate downstream command.

## Grade measurement

Reports select one complete Grader identity:

`grader_id + grader_version + grader_snapshot_sha256`

Measurements group only by the full sampling-cell key plus that selected
Grader. The summary exposes:

- attempted, completed, active, and harness-failure counts;
- graded and ungraded-completed counts;
- binary pass/fail counts and pass rate;
- Bernoulli standard error and a 95% Wilson interval;
- mean checker score and standard error where numeric scores exist.
- model-judge vote count, sampled-run count, mean agreement, and disagreement
  rate when the selected Grade carries judge metadata.

Runner failures are not model failures. Ungraded completed Runs are not failed
Grades. A changed Grader snapshot cannot be mixed with the selected snapshot;
the caller must choose one identity explicitly.

## C3 protection

The grouping key retains task, task version, config, config version, model, and
Grader snapshot. The measurement API never emits one rolled-up score across
heterogeneous predicate URIs, meters, tenants, or other dimensions that are not
part of this generic cell. A future report may add an explicit cross-cell policy
but cannot infer one from the renderer.

## Report surface

The generic report path selects one complete Grader identity and filters to the
cells in a sampling manifest:

```bash
j-rig report \
  --sampling-manifest ./sampling-manifest.yaml \
  --grader-id quality-judge \
  --grader-version "1" \
  --grader-snapshot-sha256 sha256:<64-hex> \
  --db ./j-rig.db \
  --json
```

The JSON result includes the selected observations and per-cell measurements,
including execution counts, uncertainty, and judge-vote disagreement. The
explicit selector prevents a regrade from silently replacing the snapshot a
report was intended to measure.

## Non-goals of this slice

This contract does not yet define concurrent batch execution, cross-cell
roll-up policy, or the serve/static publication surface. Those remain dependent
evolution slices.
