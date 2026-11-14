# 044 AT-DECR: `j-rig suite` replaces `j-rig batch`

**Status:** Decided, 2026-10-05. Decided by the project lead (CTO, owner-delegated).
**Bead:** htjt.22 (Decide whether j-rig suite should subsume j-rig batch).

## Question

Two commands ran a balanced Task × Config evaluation set from a manifest.
Should one replace the other?

## What each command does

| | `j-rig batch` | `j-rig suite` |
|---|---|---|
| Input | explicit list of task/config pairs | tasks and configs; runs every combination |
| Balanced target-N passes, resumable | yes | yes |
| Grades every run with a named grader | no | yes (grader required) |
| Writes an audit file | no | yes |
| Produces the unified report (HTML, `--serve`) | no | yes |

Both use the same sampling planner and the same raw-run ledger, so the runs
themselves are identical.

## Decision

`j-rig suite` is the one supported command. `j-rig batch` is deprecated.

1. `batch` keeps working unchanged in the next release and prints a one-line
   notice on stderr that names `suite`. Nothing that uses it breaks.
2. `batch` is removed in the release after that.
3. `suite` does not gain `batch`'s two extras (explicit pairs, no grading).

## Why

- **One way to do one job.** Two near-identical commands make users guess.
- **The customer needs the evidence `suite` produces.** A verdict per run, an
  audit file and a report are what make a result usable. `batch` stops at raw
  runs.
- **Integrity.** A supported path that produces runs nobody judged is the wrong
  default for an evaluation product. Every supported run should end in a grade.
- **No speculative features.** Nothing in this repo, the nightly roster or the
  marketplace uses `batch`. Someone who needs only some combinations writes a
  smaller suite. If a real need for explicit pairs appears, it is added to
  `suite` then, with tests.

## Rejected

- **Keep both.** Leaves the confusion in place and splits fixes across two
  code paths.
- **Delete `batch` now.** It is in the published CLI (`@intentsolutions/jrig-cli`
  0.4.0). Removing it without a notice period would break anyone using it
  without warning.
- **Make `batch` a wrapper around `suite`.** `suite` requires a grader and
  writes different output, so a wrapper would change `batch`'s behaviour
  silently. A plain notice is simpler and honest.
