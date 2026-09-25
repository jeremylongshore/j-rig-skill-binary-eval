# Self-Contained Unified Report HTML

**Status:** Accepted implementation contract
**Date:** 2026-08-02
**Scope:** `j-rig report --unified`, `j-rig suite`, `@j-rig/core` report projection

## Decision

The unified JSON projection now has a self-contained HTML projection for local
review. The renderer lives in `@j-rig/core` so the standalone report command
and the suite lifecycle use the same Task × Config × Model contract and the
same no-heterogeneous-rollup rule.

The HTML artifact is an unsigned local projection. It is suitable for opening
from disk, attaching to a review, or serving from an explicitly controlled
static location after the operator has made the publication decision. It is
not itself a signed Evidence Bundle, rollout authorization, or dashboard
ingest payload.

## CLI contract

The unified report command accepts `--html` in the same selector shape as
`--json`:

```bash
node packages/cli/dist/index.js report \
  --unified \
  --db ./j-rig.db \
  --grader-id answer-checker \
  --grader-version 1.0.0 \
  --grader-snapshot-sha256 sha256:<64 lowercase hex> \
  --html \
  --output ./report.html
```

`--html` and `--json` are mutually exclusive. When `--output` is omitted,
the selected projection is written to stdout. Markdown remains the default
terminal projection when neither flag is present.

`j-rig suite` writes all three local projections beside its audit manifest:

```text
.j-rig/suites/<suite-id>/
  manifest.json
  report.json
  report.md
  report.html
```

The audit's additive `report.html` path is recorded with the existing JSON and
Markdown paths. Re-running a suite keeps the same deterministic report
locations and does not create duplicate audit records.

## Safety and accessibility boundary

The renderer:

- escapes report-controlled values before inserting them into markup;
- embeds CSS only, with no scripts, external assets, fonts, or network fetches;
- gives the document a language, title, skip link, labelled sections, table
  captions, header scopes, and text labels for statuses and empty data;
- keeps wide tables usable through responsive overflow and provides reduced-
  motion and print styles;
- renders explicit no-data rows and never invents an overall pass rate across
  heterogeneous cells.

## Non-goals and downstream seams

This slice does not add a live HTTP server, public hosting, Evidence Bundle
signing, Rekor publication, dashboard ingestion, or external-judge vote
aggregation. Those consumers must continue to verify the selected report and
apply their own visibility and rollout policy before treating it as published
evidence.

Existing suite audit readers remain compatible because `report.html` is
additive; older audits without that field remain readable.

## Verification

The implementation is covered by core escaping/no-data tests, CLI unified-report
tests, and suite artifact tests. The repository build and full check gates must
pass before the change is considered complete.
