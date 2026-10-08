# 046 AT-SPEC: Structured deterministic checks (exit_code, json_path, file_sha256, schema_valid)

**Status:** Implemented, 2026-10-08.
**Bead:** dn6j.4 (Add exit-code, JSON-path, file-hash and schema-valid check types to J-Rig deterministic checks).
**Origin:** whiteglove-pdf `000-docs/010-TQ-QAPL-iep-test-plan.md` § 6, gap 4.
**Builds on:** `045` (claude-code execution provider and trajectory checks).

## Problem

Deterministic checks were text-only (`contains`, `regex_match`, `min_length`, …).
A CLI-first skill, or any skill whose output is a JSON receipt or a produced file,
had to be graded outside J-Rig: nothing could assert an exit code, a value inside
a JSON document, a file's exact bytes, or a document's shape.

## What ships

Four checks in `packages/core/src/checks/structured-checks.ts`, on both grading
surfaces.

| Check | Params | Passes when |
| --- | --- | --- |
| `exit_code` | `equals` (0–255) | the observed process exit code equals `equals` |
| `json_path` | `path`, optional `file`, exactly one of `exists` / `equals` / `matches` | the path exists (or not), its value structurally equals `equals`, or its scalar value matches the `matches` regex |
| `file_sha256` | `path`, `sha256` (64 hex, optional `sha256:` prefix) | an observed file at `path` has exactly that sha256 |
| `schema_valid` | `schema` (inline object), optional `file` | the JSON document validates against `schema` |

`json_path` uses a deliberately small, single-value JSONPath subset: `$`, `.key`,
`['key']`, `["key"]`, `[n]`. Wildcards, slices, filters and recursive descent are
rejected at load, because a binary check asserts on exactly one value. `equals`
is structural JSON equality (object key order is irrelevant, array order is
significant); `equals: null` is a real assertion that the value is JSON null.

`schema_valid` is pinned to JSON Schema **draft 2020-12** (Ajv's `Ajv2020`,
`ajv` pinned to 8.20.0). A `$schema` naming any other dialect is rejected. Strict
schema mode rejects unknown keywords, so a misspelled keyword fails load
instead of silently validating everything. The stylistic strict rules
(`strictRequired`, `strictTypes`, `strictTuples`) stay off because they reject
valid 2020-12 schemas. `format` is an annotation (the 2020-12 default): no format
vocabulary is loaded. Remote `$ref`s cannot resolve and fail at load.

### Skill eval criteria (`j-rig eval`)

```yaml
- id: receipt-status-ok
  description: The receipt reports success
  method: deterministic
  deterministic_check: json_path
  deterministic_check_params: { path: "$.status", equals: ok, file: out/receipt.json }
```

- The JSON document is the response text, or with `file:` a text file the
  claude-code execution provider observed the run produce (its content comes
  from the captured text artifacts).
- `file_sha256` reads the trajectory's sha256 manifest, so it also covers binary
  files whose content is never captured.
- File checks fail closed when the provider records no trajectory, and when the
  trajectory's `stop` is not `completed` (the same refusal as the trajectory
  checks).
- `exit_code` is refused at spec load: a skill case is a model turn, not a
  process, so the check could only ever fail.

### Command-run graders (`j-rig grade`)

`GraderCheckSchema` is now a discriminated union on `type`. `output_contains`
keeps its exact shape, so every existing grader keeps its snapshot hash (a test
pins the pre-change hash). The structured checks carry their params flat:

```yaml
id: cli-checker
version: 1.0.0
kind: deterministic
checks:
  - { id: exit-ok, type: exit_code, equals: 0 }
  - { id: status, type: json_path, path: "$.status", equals: ok }
  - { id: shape, type: schema_valid, schema: { type: object, required: [status] } }
  - { id: pdf, type: file_sha256, path: out/report.pdf, sha256: "4480c3f1..." }
```

Each Grade check result keeps `expected: string`. For `output_contains` it is the
needle, as before; for a structured check it is the check's params as JSON
(for example `{"equals":0}`). Route on the result's `type` before reading it.

`j-rig grade` passes the sealed Run's exit code and artifact manifest. File
content is not sealed for command Runs, so `json_path` / `schema_valid` with
`file:` fail closed there and the Grade says why.

#### `harness.completed_exit_codes`

The generic runner seals any non-zero exit as `runner_error`, and only
`completed` Runs can be graded, so without a change an `exit_code` grader could
only ever see 0. A config may now declare `harness.completed_exit_codes`
(non-empty list of 0–255; an empty list is rejected at load, since a config
cannot seal nothing as completed): those exits seal a `completed` Run. It is optional
with no schema default (per `031`, a default would change every sealed config
snapshot); the runner applies `[0]` when it is absent.

## Validation timing

Every param is validated when the spec or grader loads: the JSONPath is parsed,
the regex compiled, the schema compiled, the digest shape checked, `file` paths
must be relative without `..`. A mistake fails `j-rig validate` / `j-rig grade`
before any model spend. The checks re-validate at run time and fail closed.

## Limits and non-goals

- The JSONPath subset cannot select multiple values; write one check per value.
- Command Runs expose a manifest, not file bodies. The `ExecutableRunner` itself
  still records no artifacts (`artifacts: []`); `file_sha256` on a command Run
  only passes for a runner that populates the manifest.
- No `format` assertions in `schema_valid`.

## Tests

- `packages/core/src/checks/structured-checks.test.ts` (fixtures in
  `checks/__fixtures__/structured/`): JSONPath parsing, every check's pass and
  fail paths, spec-load rejections, claude-code produced files (text and binary),
  truncated-trajectory refusal, grader union, pinned legacy snapshot hash.
- `packages/cli/src/commands/grade.test.ts`: a real command Run that exits 3 under
  `completed_exit_codes: [0, 3]`, graded by all four checks through `j-rig grade`.
- `packages/core/src/execution/executable-runner.test.ts`: `completed_exit_codes`.
