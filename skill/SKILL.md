---
name: j-rig-eval
description: Evaluate an Agent Skill with JRig and return an evidence-backed ship, warn, block, or obsolete-review decision. Use when grading, scoring, release-gating, regression-testing, or comparing a SKILL.md before publication. Trigger with "evaluate this skill", "grade this SKILL.md", "run JRig", or "gate this skill".
version: 1.0.0
author: Jeremy Longshore <jeremy@jeremylongshore.com>
license: Apache-2.0
compatibility: Requires Node.js 20+, the j-rig CLI, a target skill directory, an evaluation spec, and credentials for a real supported model provider.
tags:
  - evaluation
  - skill-quality
  - release-gate
  - regression-testing
  - evidence
user-invocable: true
argument-hint: "<skill-directory> [--spec <path>] [--models <model,...>] [--full]"
allowed-tools:
  - Read
  - "Bash(j-rig:*)"
model: inherit
effort: high
---

# JRig Skill Evaluation

## Overview

Evaluate an Agent Skill with JRig's binary-evaluation harness, returning the
rollout decision first and citing the evidence behind failures or uncertainty.
Treat observed behavior as authoritative over claims in `SKILL.md`.

JRig evaluates five dimensions by default. The opt-in regression and naked-model
checks need additional inputs and can roughly double cost. Always read the
rollout decision; a completed run may still warn, block, or require review.

## Prerequisites

Before running an evaluation, confirm:

1. Node.js 20 or newer and `j-rig` are installed.
2. The target directory contains the `SKILL.md` to evaluate.
3. An evaluation spec is available. Pass `--spec` unless the target root
   contains `eval-spec.yaml` or `eval-spec.yml`.
4. Credentials for a real supported provider are present. Stub mode is useful
   for plumbing tests only and is not release evidence.
5. Any command named by the spec is trusted. `--run-self-test` executes that
   command without a shell and with a scoped environment, but it still runs
   target-controlled code.

## Instructions

### Step 1: Resolve inputs

Identify the target skill directory, evaluation spec, provider, and models.
Read the spec and note blocker criteria, sacred regression cases, self-test
commands, and expected evidence paths.

If the user supplies `--full`, translate it into both opt-in checks:

- add `--regression-baseline BASELINE_JSON`;
- add `--baseline-check`.

Ask for the regression baseline path if it is not already known. Do not invent
one.

### Step 2: Run the preflight

```bash
j-rig check TARGET_SKILL --json
```

Stop and repair package-integrity failures before evaluation. The eval command
then validates its spec and provider configuration. Never report stub-backed
results as a production gate.

### Step 3: Run the evaluation

Prefer machine-readable output and an evidence bundle:

```bash
j-rig eval TARGET_SKILL \
  --spec EVAL_SPEC \
  --models MODEL_ID \
  --provider PROVIDER_ID \
  --json \
  --emit-bundle EVIDENCE_JSON
```

Add only necessary controls: `--run-self-test`, `--samples 3`, judge provider
and model flags, regression or baseline checks, `--trace-boundary`, or the
explicit scope reductions `--no-trigger` and `--no-functional`.

The repository's dogfood spec is `skill/eval.yaml`, so evaluate it with an
explicit `--spec skill/eval.yaml`.

### Step 4: Interpret the result

Read the JSON rollout decision rather than treating exit code zero as approval:

- `ship`: all evaluated blockers and sacred cases passed;
- `warn`: evaluation completed with non-blocking failures or uncertainty;
- `block`: a blocker or sacred regression failed;
- `obsolete_review`: the naked model matched the skill and the skill's value
  should be reviewed.

Exit code `0` means evaluation completed, including completed `warn`, `block`,
and `obsolete_review` results. Exit code `1` means a package or runtime failure.
Exit code `2` means the judge path failed or nothing could be evaluated; retain
the generated error evidence and do not manufacture a rollout decision.

### Step 5: Report evidence

Lead with the exact decision and models. Name failed, uncertain, blocker, and
sacred criteria; included and omitted dimensions; non-secret provider and judge
identities; artifact paths; and the smallest remediation and rerun command.

## Output

Return a concise evidence-backed gate report:

```text
Decision: BLOCK
Models: MODEL_IDS
Coverage: default 5/7; regression included; baseline omitted
Blocking evidence:
- CRITERION: observed failure and evidence pointer
Artifacts: JSON, database, and bundle paths
Next action: specific repair and rerun command
```

The `--emit-bundle` artifact is a kernel-validated array of in-toto
`gate-result/v1` statements, one per model. Preserve it with the release record.

## Error Handling

- Preflight failure: correct the target package and rerun `j-rig check`.
- Eval setup failure: correct the spec or provider configuration and rerun.
- Missing default spec: pass `--spec`; only two default filenames are discovered.
- Provider or judge failure: retain evidence, fix it, and never substitute stubs.
- Exit code `2`: report that no valid gate decision was produced.
- Self-test failure: inspect the trusted spec command and its scoped inputs;
  never broaden execution permissions to make it pass.
- `warn` or `block`: remediate the named criteria and rerun the same model and
  option set so results remain comparable.

## Examples

Evaluate the repository dogfood skill with default five-dimension coverage:

```bash
j-rig check skill --json
j-rig eval skill --spec skill/eval.yaml --models MODEL_ID \
  --provider PROVIDER_ID --json --emit-bundle artifacts/j-rig-evidence.json
```

Run all seven dimensions when a valid regression baseline is available:

```bash
j-rig eval TARGET_SKILL --spec EVAL_SPEC --models MODEL_ID \
  --provider PROVIDER_ID --regression-baseline BASELINE_JSON \
  --baseline-check --json --emit-bundle EVIDENCE_JSON
```

## Resources

- [Evaluation contract and decision semantics](references/evaluation-contract.md)
- [Repository README](https://github.com/jeremylongshore/j-rig-skill-binary-eval#readme)
- [Evaluation specification example](eval.yaml)
- [Apache 2.0 license](https://github.com/jeremylongshore/j-rig-skill-binary-eval/blob/main/LICENSE)
