# MiniMax M3 Phase 3 Real-Provider Dogfood

**Plan:** `IEP-EVAL-EVOLUTION-001`
**Bead:** `bd_000-projects-htjt.4.1`
**GitHub issue:** [j-rig-skill-binary-eval#261](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/261)
**Status:** COMPLETE — provider path verified; parent Phase 3 remains open
**Date:** 2026-08-02

## Purpose

The original Phase 3 spot-check was blocked by an unfunded DeepSeek account.
The j-rig provider preset and nightly roster already support the funded MiniMax
account, so this run verifies that the complete trigger → execution → judgment
path produces honest real-provider evidence on the locked source roster.

This is a provider/path verification, not a claim that the evaluated skills are
ready to ship. Each result below is a real scorecard and remains independently
reviewable.

## Reproducibility

Source was checked out at the immutable commit below:

```text
repository: jeremylongshore/claude-code-plugins-plus-skills
commit:    a9dd5c02a3793412ed35525efd460b399554be13
```

The run used the process-only `MINIMAX_API_KEY` credential and pinned both
execution and judge selection:

```bash
node eval-roster/run-roster.mjs \
  --src <pinned-roster-checkout> \
  --out /tmp/iep-minimax-dogfood.OEaq1c \
  --skills audit-tests,validate-skillmd,skill-creator \
  --provider minimax \
  --models MiniMax-M3
```

The key value is intentionally absent from this document, logs, and the
committed summary. The sanitized machine-readable record is
[`evidence/minimax-m3-spotcheck-20260802/summary.json`](../evidence/minimax-m3-spotcheck-20260802/summary.json).

## Results

| Skill | Provider / model | Ground truth | Score | Decision | Provider failure |
|---|---|---:|---:|---|---:|
| `audit-tests` | `minimax / MiniMax-M3` | `true` | 4/5 (80%) | `warn` | no |
| `validate-skillmd` | `minimax / MiniMax-M3` | `true` | 2/5 (40%) | `warn` | no |
| `skill-creator` | `minimax / MiniMax-M3` | `true` | 5/10 (50%) | `warn` | no |

All three specs completed with `judge_provider=minimax`,
`judge_model=MiniMax-M3`, and zero `unsure` votes in the five-sample judge
passes. The warnings are model/skill score outcomes, not account or transport
failures. No synthetic stub result was emitted.

## Boundary classification

`doc-filing` is **baseline-only / not evaluated** for this spot-check. It is not
listed in the pinned `eval-roster/roster.json`, and the pinned source checkout
has no roster path for it. Adding it requires a separate source/roster change;
this run does not infer a grade for an absent skill.

The parent Phase 3 bead remains open for the broader shortlist, tool-dependent
classification, and scale-up decision. This child closes the funded-provider
activation and three-spec real-path prerequisite only.

## Operational result

MiniMax M3 is now the documented provider for local and nightly roster
execution:

- preset: `--provider minimax`;
- endpoint: `https://api.minimax.io/v1`;
- model: `MiniMax-M3`;
- credential: `MINIMAX_API_KEY`, injected at runtime only;
- reasoning normalization: strip only a leading `<think>…</think>` block;
- outage behavior: real-provider failures remain fail-closed and are never
  converted into `ground_truth: true` grades.

The nightly roster already uses this provider/model pair from `roster.json` and
the repository secret; this change makes the same path explicit in the package
documentation and durable evidence record.
