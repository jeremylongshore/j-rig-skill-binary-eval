# Generic Runner, Config, and Raw Run Contract

**Plan:** `IEP-EVAL-EVOLUTION-001`
**Bead:** `bd_000-projects-htjt.6`
**Status:** ACTIVE — implementation slice
**Date:** 2026-08-01

## Purpose

J-Rig now has a generic execution seam beneath the skill-specific
`SkillEvalSpec` profile. A task is data, a configuration names the model and
harness, and a Runner produces an ungraded observation. Graders are explicitly
downstream and must never rewrite the raw observation.

The historical `runs` table remains the compatibility store for the existing
skill-evaluation Evidence Bundle path. The generic substrate uses `raw_runs`
and `raw_run_artifacts` so arbitrary tasks do not inherit skill-only columns.

## Task and configuration files

Task and configuration files are YAML (JSON is accepted by the YAML parser):

```yaml
# task.yaml
id: answer-task
version: "1"
description: Answer the supplied question
input:
  question: What is two plus two?
```

```yaml
# config.yaml
id: local-harness
version: "1"
model: fixture-model
harness:
  command: node
  args: [./fixtures/answer-harness.mjs]
  timeout_ms: 30000
  cwd: .
parameters:
  temperature: 0
```

The `command` and `args` fields are separate. J-Rig invokes the harness with
`shell: false`; task content cannot become shell syntax. Relative harness
working directories are resolved from the configuration file directory.

## Runner protocol

Every invocation receives one JSON `RunnerRequest` document on stdin:

```json
{
  "run_id": "raw_<sha256>",
  "task": { "id": "answer-task", "version": "1", "input": {} },
  "config": { "id": "local-harness", "version": "1", "model": "fixture-model" },
  "model": "fixture-model",
  "sample_index": 0
}
```

The same lineage is available through `J_RIG_RUN_ID`, `J_RIG_TASK_ID`,
`J_RIG_TASK_VERSION`, `J_RIG_CONFIG_ID`, `J_RIG_CONFIG_VERSION`,
`J_RIG_MODEL`, and `J_RIG_SAMPLE_INDEX`. Stdout and stderr are captured as
observations. The runner inherits only a small non-secret environment allowlist
(`PATH`, `LANG`, and `LC_ALL`) plus explicit configuration variables.

Runner status is separate from quality:

- `completed`: the harness exited zero; its stdout is still ungraded model or
  task output.
- `runner_error`: the harness failed to start or exited non-zero.
- `timed_out`: the configured timeout killed the harness.

## Raw Run ledger

`raw_runs` is keyed by an idempotent SHA-256 lineage identity over
`task_id`, `task_version`, `config_id`, `config_version`, `model`, and
`sample_index`. The unique lineage constraint makes a resumed sample return the
existing row rather than create a duplicate.

J-Rig inserts a `pending` row before spawning the harness, transitions it to
`running`, then seals it exactly once with stdout, stderr, exit code, signal,
timing, status, request/config/task snapshots, and an optional artifact
manifest. Terminal rows cannot be overwritten. Artifact references require a
`sha256:<64 lowercase hex>` digest and a relative path.

The raw record is the source of truth. Future named Graders may create multiple
Grade rows over the same sealed Run, but grading is not part of this command and
cannot mutate the Run.

## CLI

```bash
j-rig run \
  --task ./task.yaml \
  --config ./config.yaml \
  --sample-index 0 \
  --db ./j-rig.db \
  --json
```

Re-running the same task/config/model/sample reads the sealed row and reports
`reused: true`. A new sample index creates a new Run identity. A non-completed
runner result is retained and the command exits non-zero, while preserving the
raw stdout/stderr for diagnosis.

## Non-goals of this slice

This contract does not yet define model-judge Graders, regrade snapshots,
balanced target-N sampling, suite/batch manifests, or report aggregation. Those
remain the explicitly dependent beads `.3`, `.5`, `.7`, and `.8` under the
master evaluation-platform umbrella.
