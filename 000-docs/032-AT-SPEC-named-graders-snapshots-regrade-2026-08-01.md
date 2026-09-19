# Named Graders, Immutable Grade Snapshots, and Regrade Contract

**Plan:** `IEP-EVAL-EVOLUTION-001`
**Bead:** `bd_000-projects-htjt.7`
**Status:** ACTIVE — deterministic and model-judge implementation slice
**Date:** 2026-08-01

## Purpose

The generic raw Run substrate records what the harness observed. This slice
adds the first explicit quality boundary: a named, versioned Grader evaluates a
completed Run and creates an immutable Grade. A Grade stores the exact Grader
definition used, its digest, every check result, and the final verdict.

The existing skill-specific `runs` and Evidence Bundle path remain compatible.
The new `grades` table is downstream of `raw_runs`; it never rewrites a Run and
it cannot grade runner failures or timeouts.

## Grader definition

J-Rig supports two Grader kinds. Deterministic graders check whether stdout
contains named expected strings:

```yaml
# grader.yaml
id: answer-contract
version: "1"
kind: deterministic
description: The harness returned the required answer
checks:
  - id: answer-is-four
    type: output_contains
    expected: "4"
    required: true
```

`required` defaults to `true`. The Grade verdict is `pass` only when every
required check passes. The score is the fraction of all checks that pass; this
score is diagnostic and does not replace the binary verdict.

### Model-judge graders

A model-judge grader delegates one named criterion to the shared J-Rig judgment
engine. The model, prompt, criterion, sample count, and optional temperature
are part of the immutable snapshot:

```yaml
id: quality-judge
version: "1"
kind: model_judge
description: The answer is correct and useful
model: MiniMax-M3
criterion_id: answer-quality
criterion_description: The output answers the question correctly and explains why
judge_prompt: Answer yes only when the output satisfies the criterion.
samples: 3
judge_temperature: 0.7
```

For sampled judges, every vote, latency, measured agreement fraction, raw
`yes`/`no`/`unsure` verdict, reasoning, and disagreement flag is stored in the
Grade's `metadata_json`. The binary Grade maps `yes` to `pass` and maps `no` or
`unsure` to `fail` (fail-closed); the raw verdict remains available so a report
cannot mistake an uncertain judgment for a confident failure. Regrading creates
another immutable identity and never mutates prior evidence.

If every judge call fails, no quality Grade is stored. The command reports an
evaluation error, leaves the raw Run unchanged, and can be retried after the
provider recovers. This is different from a judge that successfully returns
`unsure`.

## Snapshot and identity

Before persistence, J-Rig serializes the parsed definition and records a
`sha256:<64 lowercase hex>` digest. A Grade identity is the tuple:

`raw_run_id + grader_id + grader_version + grader_snapshot_sha256`

The identity is content-addressed and unique. Repeating the same command is
idempotent and returns the existing Grade. Changing the definition or version
creates a new Grade row, preserving the earlier judgment for audit and
comparison.

The saved-Grade lookup happens before provider selection or model calls. An
identical snapshot, even with `--regrade`, returns its saved evidence without
new judge calls or credentials. A changed snapshot is rejected before any model
spend unless `--regrade` is supplied. These are sequential retry guarantees,
not a cross-process lock against simultaneous judge requests.

## Regrade policy

Only a `completed` raw Run can receive a Grade. A runner error or timeout is
retained as a raw observation but is not silently converted into a quality
failure.

When a Run already has a Grade for the same named Grader, a different version
requires explicit operator intent:

```bash
j-rig grade \
  --run-id raw_<sha256> \
  --grader ./grader-v2.yaml \
  --db ./j-rig.db \
  --regrade \
  --json
```

The prior Grade remains immutable. Balanced full-run sampling and aggregate
report presentation build on this persistence boundary in dependent evolution
slices.

## CLI

```bash
j-rig grade \
  --run-id raw_<sha256> \
  --grader ./grader.yaml \
  --db ./j-rig.db \
  --json
```

The JSON result includes the stored Grade row and whether it was newly created.
The command loads and validates the YAML definition before evaluating stdout;
it never executes the task again.

For a `model_judge` definition, J-Rig resolves the same provider families as
`j-rig eval`. Pin the provider explicitly when reproducibility matters:

```bash
j-rig grade \
  --run-id raw_<sha256> \
  --grader ./quality-judge.yaml \
  --provider minimax \
  --db ./j-rig.db \
  --json
```

The provider reads `MINIMAX_API_KEY` and uses the model pinned in the grader
snapshot. `--provider anthropic` and the other OpenAI-compatible presets follow
the same credential rules as `j-rig eval`; `--provider stub` remains gated by
`J_RIG_ALLOW_STUB=1` and is never ground truth.

### Snapshot selection

Consumers that need a particular judgment select it by the full identity tuple
(`raw_run_id`, `grader_id`, `grader_version`, and snapshot digest). The DB
`getGradeByIdentity` helper and the downstream sampling/report work therefore
never silently replace an earlier Grade with the newest regrade.
