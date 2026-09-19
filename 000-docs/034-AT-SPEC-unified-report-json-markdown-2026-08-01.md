# Unified Report JSON and Markdown Contract

**Plan:** `IEP-EVAL-EVOLUTION-001`
**Bead:** `bd_000-projects-htjt.5`
**Status:** ACTIVE — implementation slice
**Date:** 2026-08-01

## Purpose

J-Rig now has a versioned report projection over the generic raw Run ledger
and one explicitly selected immutable Grader snapshot. The report is a local
projection, not a signed Evidence Bundle and not an authorization to publish
unverified rows to the public dashboard.

## Selection and grouping

Every report selects the complete Grader identity:

`grader_id + grader_version + grader_snapshot_sha256`

Cell metrics retain the full Task × Config × Model identity. The report has no
global pass-rate rollup across cells; pass rate, Wilson interval, score mean,
and score standard error remain per cell. Harness failures and ungraded
completed Runs are separate counts, never model-quality failures.

## JSON contract

The machine-readable shape is `j-rig/unified-report/v1`:

```json
{
  "schema": "j-rig/unified-report/v1",
  "generated_at": "2026-08-01T00:00:00.000Z",
  "grader": {
    "grader_id": "answer-checker",
    "grader_version": "1.0.0",
    "grader_snapshot_sha256": "sha256:<64 lowercase hex>"
  },
  "summary": {
    "cell_count": 1,
    "attempted_runs": 3,
    "completed_runs": 2,
    "active_runs": 0,
    "harness_failure_count": 1,
    "graded_runs": 2,
    "ungraded_completed_runs": 0,
    "pass_count": 1,
    "fail_count": 1
  },
  "cells": [],
  "runs": []
}
```

`cells` contains the full per-cell uncertainty records from document 033.
`runs` preserves raw Run lineage, sample index, status, and the selected Grade
or `null` when the completed Run is still ungraded. Empty `cells` and `runs`
are valid and render as explicit no-data, not as a pass.

## CLI

```bash
j-rig report \
  --unified \
  --db ./j-rig.db \
  --grader-id answer-checker \
  --grader-version 1.0.0 \
  --grader-snapshot-sha256 sha256:<64 lowercase hex> \
  --json \
  --output ./report.json
```

Omit `--json` for terminal-friendly Markdown. `--output` writes exactly the
selected JSON or Markdown projection. The report generation timestamp is
included in the output; all Run and Grade identities remain sourced from the
database.

## Publication boundary

The report projections are intentionally unsigned and local. JSON, Markdown,
and the self-contained `--html` artifact are review surfaces, not signed
Evidence Bundles. A future adapter may turn an approved report into a
kernel-valid Evidence Bundle, but it must apply the existing verify-before-
render and visibility policy before any dashboard or public publication. The
dashboard must not ingest a local SQLite file or treat these reports as signed
rollout decisions.

## Non-goals of this slice

This contract does not implement a live server, public hosting, external-judge
vote aggregation, or Evidence Bundle signing. The local static HTML projection
and generic suite/batch execution are now implemented downstream slices; live
publication, dashboard ingestion, and signed promotion remain separate seams.
