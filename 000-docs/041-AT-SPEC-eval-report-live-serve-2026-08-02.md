# Local Live Serving for Evaluation Reports

**Plan:** `IEP-EVAL-EVOLUTION-001`
**Bead:** `bd_000-projects-htjt.5.2`
**Status:** Accepted implementation contract
**Date:** 2026-08-02

## Purpose

The unified and generic-suite reports are already self-contained HTML
artifacts. This slice adds a local operator server so a user can inspect the
selected report without opening a file manually or navigating SQLite tables.

## CLI

Serve a selected unified report:

```bash
j-rig report \
  --unified \
  --db ./j-rig.db \
  --grader-id answer-checker \
  --grader-version 1.0.0 \
  --grader-snapshot-sha256 sha256:<64 lowercase hex> \
  --html \
  --serve
```

Serve a generated suite report:

```bash
j-rig suite ./suite.yaml \
  --db ./j-rig.db \
  --serve
```

The server chooses an available port by default. Use `--port 4317` for a
stable local port. `--host` accepts only `127.0.0.1` or `::1`; public and
wildcard bind addresses fail closed.

## HTTP surface

Only three paths are exposed:

- `/` and `/index.html` return the generated report HTML;
- `/healthz` returns deterministic JSON identifying the service as an
  unsigned-local, loopback-only report surface; and
- every other path returns `404 Not Found`.

The server sets `Content-Security-Policy`, `X-Content-Type-Options`, and
`Cache-Control: no-store`. It serves no scripts, external assets, or network
fetches. `Ctrl-C` and `SIGTERM` close the listener and remove signal handlers.

### Host header check

Binding to loopback keeps remote clients out but does not stop DNS rebinding: a
hostile page can resolve its own domain to `127.0.0.1` and have the operator's
browser request the report. That request still carries the attacker's domain
in `Host`, so every route, including `/healthz`, answers `421 Misdirected
Request` unless the `Host` hostname is `127.0.0.1`, `localhost`, or `[::1]`
(any port). A request with no `Host` header is rejected by Node's HTTP/1.1
parser with `400` before it reaches the handler.

## Trust and publication boundary

The report remains an unsigned local projection. Loopback serving is a
developer/operator convenience, not verified ingest, Evidence Bundle signing,
rollout authorization, or public dashboard publication. The existing dashboard
adapter keeps the report under `site-internal/`; the tailnet route and any
public promotion remain human-gated downstream decisions.

## Verification

The CLI server module tests successful report and health responses, 404
behavior, configured ephemeral ports, non-loopback refusal, and invalid port
refusal. Existing report/suite tests continue to cover their projection and
resumability contracts.
