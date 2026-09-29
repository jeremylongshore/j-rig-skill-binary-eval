# J-Rig eval headroom and saturation signal

**Status:** IMPLEMENTED — `bd_000-projects-htjt.25`
**Plan:** `IEP-EVAL-EVOLUTION-001`
**Date:** 2026-09-29

## Purpose

An eval that a skill already passes at or near 100 percent can no longer show
that a change helped. Before this change, J-Rig reported that case as a clean
pass, and the Skill Refiner would score candidate edits against a set with no
room left to measure. This record adds a headroom measurement that says so
explicitly.

The trigger was Anthropic's published eval-design guidance for its
`build-eval` and `hillclimb` commands: the strongest configuration should sit
well below 100 percent, and eval noise should be smaller than the smallest
improvement worth acting on.

## What is measured

`assessHeadroom()` in `@j-rig/core` (`governance/headroom.ts`) takes the passed
count and the number of criterion evaluations, the same unit the scorecard's
`pass_rate` uses, and returns one of four statuses:

| Status | Rule |
| --- | --- |
| `saturated` | observed pass rate is at or above the ceiling |
| `near_ceiling` | below the ceiling, but the 95% Wilson upper bound reaches it |
| `headroom` | the whole 95% Wilson interval sits below the ceiling |
| `no_data` | nothing was scored |

The Wilson interval is the existing `wilsonInterval()` from the sampling
substrate (000-docs/033), so small criterion counts are treated honestly: 9 of
10 is `near_ceiling`, 8 of 10 is `headroom`, at the default ceiling.

The assessment records `ceiling`, `ceiling_source` (`spec` or `default`),
`passed`, `trials`, `pass_rate`, and `confidence_interval_95`.

## Decisions

1. **Headroom is a measurement of the eval, not a verdict on the skill.** It
   never changes the rollout decision, `gate_decision`, `gate_reasons`, or the
   promotion evidence. It rides beside them.
2. **The ceiling lives in the eval spec as optional `headroom_ceiling`, in
   (0, 1], with no schema default.** The runtime default is
   `DEFAULT_HEADROOM_CEILING = 0.95`, applied at assessment time. A schema
   default would rewrite every parsed spec and change its snapshot hash; the
   same rule already governs harness-config fields (000-docs/031). When
   declared, the field is carried into the canonical EvalSpec extension, so it
   is covered by the spec's content hash.
3. **An `error` row carries no headroom.** An evaluator infrastructure failure
   has no verdict (000-docs/037), so it makes no claim about headroom either.
4. **Measured per model row.** Each `j-rig:local:<skill>.<model>` row gets its
   own assessment. The nightly roster names a skill as saturated when any of
   its model rows is saturated.

## Where it appears

- `j-rig eval` console: one warning line for `saturated`, `near_ceiling`, or
  `no_data`; nothing for `headroom`.
- `j-rig eval --json`: `report.headroom` on each model result.
- `--emit-bundle`: `metadata.headroom` on each non-`error` `gate-result/v1`
  row. Additive metadata; the kernel predicate schema is unchanged.
- Nightly roster: `headroom` per skill in `roster-summary.json`, a per-skill
  console suffix, a final `saturated evals:` line, and the same line in the
  GitHub step summary.

## Deferred

- **Refiner refusal.** `accept()` in `@intentsolutions/refiner-core` should
  refuse to claim improvement against a saturated set with a named reason.
  In practice a perfect baseline cannot be beaten today, so the gate already
  rejects; the change is a clearer reason code in a published package and
  ships separately.
- **Unified report cells.** `j-rig report --unified` already shows per-cell
  Wilson intervals; a per-cell headroom column is a follow-up.
