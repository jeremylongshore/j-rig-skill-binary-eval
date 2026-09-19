# Skills-Root Eval Batch Contract

**Plan:** `IEP-EVAL-EVOLUTION-001`

**Bead:** `bd_000-projects-h08j.3`

**Status:** IMPLEMENTED on `feat/eval-batch-skills-root`
**Date:** 2026-08-01

## Purpose

`j-rig eval-batch` is the dogfood surface for evaluating a directory of
Claude Skills. It composes the existing `scaffold-spec` and `eval` commands;
it does not create a second evaluator. Every discovered skill gets a separate
child `eval` process, a separate Evidence Bundle file, and a shared SQLite
evidence store.

The batch command is deliberately honest about the boundary between a
generated baseline and deep functional evidence. A generated spec checks
trigger engagement, output presence, and prompt-leakage safety. It does not
invent skill-specific functional criteria or claim that a baseline score is a
deep quality grade.

## Discovery

The positional argument is either one skill directory or a skills root. The
root is traversed recursively in sorted order. A directory containing
`SKILL.md` is a skill leaf; nested directories below that leaf are not
discovered separately. `.git`, `.j-rig`, `node_modules`, build, dist, and
coverage directories are ignored.

Existing `eval-spec.yaml` or `eval-spec.yml` files are validated and reused.
When a skill has no spec, the command generates a validated baseline spec under
the batch artifact directory:

```text
.j-rig/eval-batches/<batch-id>/
  manifest.json
  report.json
  report.md
  report.html
  specs/<skill-slug>/eval-spec.yaml
  bundles/<skill-slug>.json
  results/<skill-slug>.json
```

Source skill directories are not modified by default. `--write-specs` is an
explicit migration convenience that writes only missing `eval-spec.yaml`
files beside the source skills; it never overwrites an existing spec.

## Command

```bash
MINIMAX_API_KEY=sk-... \
  j-rig eval-batch ~/.claude/skills \
  --provider minimax \
  --models MiniMax-M3 \
  --db ./j-rig.db \
  --batch-id skills-2026-08-01 \
  --json
```

The provider, model list, independent judge provider/model, judge sample
count, baseline comparison, self-test, and boundary tracing options are
forwarded to every child `j-rig eval` invocation. Children run sequentially so
SQLite writes remain simple and deterministic. The default is continue-on-error;
`--fail-fast` stops after the first invalid or failed skill while still writing
the partial manifest.

## Evidence and lineage

Each child receives `--emit-bundle <batch-artifact>/bundles/<skill>.json`.
The existing `eval` writer validates every row as `gate-result/v1` and records
the written bundle digest as an `evidence-bundle` artifact in the shared SQLite
store. A failed child retains its stdout/stderr result file and an error in the
manifest; it is never silently omitted.

The manifest is `j-rig/eval-batch/v1` JSON and records the absolute skill path,
relative skill path, spec provenance (`existing` or `generated`), bundle/result
paths, exit status, signal, duration, provider/model summaries, and the
completed/failed counts. It also records additive paths for the versioned
lineage/status report. `report.json`, `report.md`, and `report.html` preserve
each entry and make failed children visible without inventing a heterogeneous
quality rollup. Child Evidence Bundle metadata also carries:

```json
{
  "batch_id": "skills-2026-08-01",
  "batch_skill": "doc-filing",
  "batch_manifest": "/abs/path/.j-rig/eval-batches/skills-2026-08-01/manifest.json"
}
```

`--batch-id` is the stable lineage key for a rerun. The underlying skill eval
remains idempotent at the bundle path and preserves all SQLite run records; a
future generic target-N suite will add cell-level resumable planning on top of
the raw-run substrate documented in 033.

## Compatibility boundary

The existing `j-rig eval <skill-dir>` command remains the compatibility path
for hand-authored skill specs and existing stored evidence. `eval-batch` does
not replace or rewrite those specs. Legacy `v0.1.0-draft` Evidence Bundles
continue through `j-rig migrate <dir>` before downstream gate verification.
Generated baseline specs should be hand-edited and then treated as normal
existing specs once skill-specific criteria are added.

## Non-goals

- generated specs are not a substitute for hand-authored deep functional cases;
- stub-provider output is not ground truth and must not be published as quality
  evidence;
- the batch manifest is an audit projection, not a rollout authorization;
- the batch report is a lineage/status projection, not an overall quality score
  or rollout authorization;
- generic Task × Config × Model target-N planning remains the separate
  `sample-plan`/raw-run evolution surface.
