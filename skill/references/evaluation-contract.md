# JRig Evaluation Contract

## Coverage

JRig's evaluation pipeline has seven dimensions:

1. package integrity;
2. trigger quality;
3. functional execution;
4. judgment;
5. scoring;
6. regression comparison;
7. naked-model baseline comparison.

The normal `j-rig eval` path runs five dimensions. Regression comparison needs
`--regression-baseline`; naked-model comparison needs `--baseline-check`.
Record omitted dimensions explicitly so a partial evaluation is not presented
as full coverage.

## Input Resolution

The evaluator resolves an explicit `--spec` first. Without it, JRig looks for
`eval-spec.yaml` and then `eval-spec.yml` in the target root. Other filenames,
including this repository's `skill/eval.yaml`, require `--spec`.

The target skill controls the content under evaluation. Any self-test command
in its spec is target-controlled code. JRig invokes the command without a shell
and scopes the environment, but operators must still inspect and trust it before
using `--run-self-test`.

## Provider and Authentication Boundary

Release evidence must use a real supported model provider. Supply credentials
through the provider's supported environment or authentication mechanism and
never place secrets in the spec, command history, report, or evidence bundle.

Stub operation requires explicit `J_RIG_ALLOW_STUB=1`. It may validate local
plumbing but cannot establish model behavior and must not be accepted as
ground-truth release evidence.

## Decisions

- `ship`: evaluated blockers passed and no sacred regression failed.
- `warn`: the run completed but non-blocking failures or uncertainty remain.
- `block`: a blocker or sacred regression failed.
- `obsolete_review`: baseline comparison indicates the naked model matched the
  skill, so the skill may add no measurable value.

Averages never override a failed blocker. Observed outputs and recorded
evidence outrank prose claims.

## Exit Status

- `0`: evaluation completed. Inspect the JSON decision; it may be `ship`,
  `warn`, `block`, or `obsolete_review`.
- `1`: package or runtime failure prevented normal completion.
- `2`: the judge path failed or nothing was evaluated. Error evidence may exist,
  but no valid rollout decision should be claimed.

## Evidence

Use `--json` for deterministic parsing and `--emit-bundle` for portable release
evidence. The emitted bundle is a kernel-validated array with one in-toto
`gate-result/v1` statement per evaluated model. Preserve the report, bundle,
database path, model set, provider identity, judge identity, and exact flags.

## Failure Recovery

1. Run `j-rig check TARGET_SKILL --json` before model-backed evaluation.
2. Repair package paths before check; repair spec or provider errors at eval.
3. Preserve error artifacts from failed provider and judge runs.
4. Keep the same model set and flags after remediation for comparable evidence.
5. Never turn on stub mode or omit blockers merely to obtain a passing result.

## Repository Authorities

When implementation details drift, consult these sources in order:

1. `packages/cli/src/commands/eval.ts` for CLI flags and exit handling;
2. `packages/core/src/evaluation/` for decisions and evaluation behavior;
3. `packages/contracts/` for evidence schemas;
4. `README.md` and `docs/` for operator guidance;
5. `skill/eval.yaml` for this repository's dogfood contract.
