# Eval-Batch Summary Report Projection

**Status:** Accepted implementation contract
**Date:** 2026-08-02
**Scope:** `j-rig eval-batch`, `@j-rig/core` batch report projection

## Decision

`j-rig eval-batch` now writes a review-ready summary beside its audit
manifest and per-skill Evidence Bundle/result artifacts. The report is a
lineage and execution-status projection, not a second evaluator and not a
quality rollup across unrelated skills.

The manifest remains the batch audit source of truth. Report paths are additive
metadata, so consumers that only read the existing `j-rig/eval-batch/v1`
manifest remain compatible.

## Artifact contract

Each batch output directory contains:

```text
.j-rig/eval-batches/<batch-id>/
  manifest.json
  report.json
  report.md
  report.html
  bundles/<skill-slug>.json
  results/<skill-slug>.json
```

`report.json` uses `j-rig/eval-batch-report/v1` and records the batch id,
skills root, provider/model selection, database and manifest paths, timestamps,
summary counts, and every entry's skill/spec/result/bundle lineage. Entry
metadata includes spec provenance, status, exit/signal, duration, provider and
model observations, diagnostics, and errors.

The Markdown and HTML projections preserve the same entries and counts. A
failed entry remains visible and non-publishable. No overall pass rate, skill
ranking, or rollout decision is inferred from heterogeneous skill outputs.

## Static HTML boundary

`report.html` is self-contained and safe to open from disk: user-controlled
values are escaped; CSS is inline; there are no scripts, external assets,
fonts, or network fetches. It has a document language and title, skip link,
labelled sections, table caption and header scopes, text status labels,
responsive overflow, reduced-motion and print styles, and an explicit no-data
row.

The artifact is unsigned local review output. Signing, verified ingest, public
publication, dashboard rollout status, and Evidence Bundle promotion remain
downstream boundaries.

## Reruns and failures

`--batch-id` continues to determine stable bundle/result/manifest paths for a
rerun. The report paths are equally stable and are regenerated from the final
manifest after the child evaluations complete. Provider outages or other
failed children are represented in the report rather than converted into a
successful quality result.

## Compatibility

The existing `j-rig eval` and `j-rig eval-batch` invocation options remain
unchanged. Existing consumers can ignore the additive `report` manifest field;
generated baseline specs and legacy Evidence Bundle migration retain their
previous semantics.

## Verification

Core tests cover schema validation, escaping, accessibility markers, failed
entries, and explicit empty output. CLI tests cover report artifact paths,
manifest lineage, and failed-batch visibility. Build, lint, typecheck, format,
and full workspace tests are required before the slice is complete.
