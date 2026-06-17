---
name: j-rig-eval
description: Runs the j-rig seven-layer binary evaluation on a Claude skill and reports a ship or no-ship rollout decision. Activates when a user asks to evaluate, grade, score, or gate a SKILL.md before release.
---

# j-rig Skill Evaluation

Evaluate a Claude skill (`SKILL.md`) with the j-rig binary-eval harness and
return a clear ship or no-ship decision backed by evidence.

## When to use this skill

Use it whenever someone wants to know whether a skill change is safe to ship —
before opening a release PR, after editing a skill body, or when gating a skill
in CI. The decision is binary: every criterion is a yes or no, and a single
blocker failure blocks release regardless of the average.

## Instructions

1. Locate the skill directory that contains the `SKILL.md` under evaluation and
   the eval contract that lists its criteria and test cases.
2. Run the full seven-layer evaluation against the skill: package integrity,
   trigger quality, functional execution, judgment, scoring, evidence
   persistence, and the rollout report.
3. Read the rollout decision. A `ship` decision means every blocker passed and
   no regression-critical criterion failed. A `block` decision means at least
   one blocker failed. A `warn` decision means non-blocking criteria need
   attention. An `obsolete_review` decision means the naked model matched the
   skill and the skill may add no value.
4. Report the decision plainly, then list any failing criteria with their
   reasons so the author knows exactly what to fix.

## Decision rules

- A blocker failure cannot be averaged out by passing criteria — it blocks.
- A regression on a sacred case blocks release even if the overall score rose.
- Observed behavior outranks claimed behavior: grade what the skill actually
  produced, not what its description promises.
- The evaluator is always separate from the skill under test; the skill never
  judges itself.

## Examples

Input: a request to evaluate a commit-message skill before release.
Output: a ship-or-no-ship decision plus the per-criterion pass and fail rows,
with one-line reasons for every failure.

Input: a request to gate a skill in a pull request.
Output: a no-ship decision naming the single blocker that failed, so the author
can fix exactly that one thing and re-run.
