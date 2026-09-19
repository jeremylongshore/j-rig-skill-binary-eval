# @intentsolutions/jrig-cli

The **J-Rig** seven-layer binary evaluation CLI for Claude Skills (`SKILL.md`
artifacts) — published as a self-contained npm package so any repo can install
the `j-rig` command and gate skill changes in CI.

Scores every skill change across package integrity, trigger quality, functional
quality, regression protection, baseline value, model variance, and rollout
safety — all binary yes/no criteria with an evaluator that is always separate
from the skill under test.

> The published binary is named **`j-rig`** (the J-Rig brand and CLI identity are
> unchanged). Only the npm package scope is `@intentsolutions/*`.

## Install

```bash
# Global — gives you the `j-rig` command everywhere
npm install -g @intentsolutions/jrig-cli

# Or per-repo (recommended for CI pinning)
npm install -D @intentsolutions/jrig-cli
pnpm add -D @intentsolutions/jrig-cli
```

This package is **self-contained**: the internal eval engine is bundled into the
published artifact. It pulls only real npm runtime dependencies (notably the
native `better-sqlite3` for evidence persistence and the published
`@intentsolutions/refiner` for the `j-rig refine` loop) — there are no
unpublished workspace packages to resolve.

## Usage

```bash
j-rig --version                      # report the installed CLI version
j-rig --help                         # list all commands

j-rig check <skill-dir>              # deterministic package-integrity checks
j-rig validate <eval-spec.yaml>      # validate an eval spec / contract YAML
j-rig eval <skill-dir> --spec ...    # binary evaluation (5 of 7 layers by default; regression + baseline are opt-in)
j-rig eval-batch <skills-root>        # scaffold missing baselines and evaluate a skills root
j-rig suite <suite.yaml>              # balanced, resumable Task × Config target-N suite
j-rig run --task ... --config ...     # generic shell-free task/config raw Run
j-rig grade --run-id ... --grader ... # named immutable Grade over a completed Run
j-rig sample-plan --manifest ...      # balanced target-N top-up plan
j-rig batch --manifest ...            # execute a resumable balanced batch
j-rig report --unified ...            # selected-Grader JSON/Markdown/HTML report
j-rig report                         # show results from the SQLite evidence DB
j-rig optimize                       # cluster failures, propose one change
j-rig drift                          # check whether a skill needs reevaluation
j-rig emit-evidence                  # wrap a gate-result into a signed Statement
j-rig migrate <dir>                  # codemod v0.1.0-draft → gate-result/v1
j-rig refine                         # eval-guided SKILL.md improvement loop
```

`j-rig eval <skill-dir>` expects an `eval-spec.yaml` (or `--spec <path>`) and
writes evidence to a local SQLite DB (`--db <path>`, default `j-rig.db`).

`j-rig eval-batch <skills-root>` discovers `SKILL.md` leaves in sorted order,
reuses existing specs, generates missing baseline specs under a batch artifact
directory, and invokes the existing evaluator once per skill. Each child emits
its own `gate-result/v1` Evidence Bundle into the shared SQLite evidence store;
the `j-rig/eval-batch/v1` manifest retains spec provenance, bundle paths,
lineage, model/provider summaries, and failures. It also writes
`manifest.json`, `report.json`, `report.md`, and self-contained `report.html`
under the batch artifact directory. The report preserves per-skill lineage and
failed/provider-outage rows; it does not synthesize an overall quality score or
rollout decision. Source skills are unchanged by default; add `--write-specs`
only when you explicitly want missing baseline specs written beside them.
Generated baselines are trigger/safety scaffolds, not deep functional evidence.
See `000-docs/035-AT-SPEC-eval-batch-skills-root-2026-08-01.md` and
`000-docs/039-AT-SPEC-eval-batch-report-projection-2026-08-02.md`.

The generic `j-rig run` command accepts YAML task/config definitions, passes one
JSON request to a shell-free harness, and persists an idempotent raw Run before
any grading. It retains stdout/stderr for completed, runner-error, and timeout
outcomes. See `000-docs/031-AT-SPEC-generic-runner-config-raw-run-2026-08-01.md`
for the request and environment protocol.

`j-rig grade` evaluates a completed raw Run with a validated, versioned
deterministic or model-judge grader definition and stores an immutable snapshot.
Pass `--regrade` to intentionally add a new version of an existing named
Grader; runner errors and timeouts are not gradeable. Model-judge graders accept
`--provider minimax` (or another configured provider), sample the shared judge
engine when `samples > 1`, and persist every vote plus disagreement metadata.
The grader's `model` remains pinned even when a provider preset has a default
model. See
`000-docs/032-AT-SPEC-named-graders-snapshots-regrade-2026-08-01.md`.

`j-rig sample-plan` reads a YAML manifest of explicit Task × Config × Model
cells and reports the next balanced sample indices needed to reach `--target-n`.
`j-rig batch` consumes a path-based suite manifest, executes those jobs in
balanced passes, and resumes from the immutable raw-run ledger; `j-rig suite`
plans and executes the same jobs from one manifest. These surfaces retain
runner failures instead of converting them into model grades. See
`000-docs/033-AT-SPEC-balanced-sampling-uncertainty-2026-08-01.md`.

`j-rig report --unified` requires `--grader-id`, `--grader-version`, and the
full `--grader-snapshot-sha256`. It emits `j-rig/unified-report/v1` JSON with
`--json`, a self-contained HTML document with `--html`, or terminal-friendly
Markdown otherwise; `--output` writes the exact projection to a file. `--html`
and `--json` are mutually exclusive. This is unsigned local output, not a
dashboard ingest or rollout decision. See
`000-docs/034-AT-SPEC-unified-report-json-markdown-2026-08-01.md` and
`000-docs/038-AT-SPEC-unified-report-html-static-2026-08-02.md`.

For the cell-scoped projection, use `--sampling-manifest` with the same three
Grader identity fields. The unified report is the versioned local projection;
neither report surface is a signed dashboard ingest or rollout decision.

`j-rig suite <suite.yaml>` is the one-command generic lifecycle. The manifest
lists Task YAML files, Config YAML files, one named Grader, and `target_n`.
Task/config paths resolve relative to the suite manifest, the Cartesian matrix
is planned deterministically, and every raw Run is idempotent by its complete
Task × Config × Model × sample identity. The command writes
`.j-rig/suites/<suite-id>/manifest.json`, `report.json`, `report.md`, and
`report.html`;
rerunning the same command resumes planned/running jobs and adds only the
fresh sample indices needed after harness failures. Existing `run`, `grade`,
`sample-plan`, `report`, `eval`, and `eval-batch` commands remain valid
compatibility seams. See
`000-docs/036-AT-SPEC-eval-suite-lifecycle-2026-08-01.md` for the manifest
schema, validation diagnostics, and migration path.

## Providers

The evaluator's judge layer talks to an LLM provider. The provider is
auto-detected from environment variables (preferring an OpenAI-compatible
endpoint) or forced with `--provider`:

| Provider     | `--provider`         | Env var             | Model id            |
| ------------ | -------------------- | ------------------- | ------------------- |
| DeepSeek     | `deepseek`           | `DEEPSEEK_API_KEY`  | `deepseek-v4-flash` |
| Kimi/Moonshot| `kimi` / `moonshot`  | `MOONSHOT_API_KEY`  | provider default    |
| OpenRouter   | `openrouter`         | `OPENROUTER_API_KEY`| provider default    |
| MiniMax      | `minimax`            | `MINIMAX_API_KEY`   | `MiniMax-M3`        |
| Anthropic    | `anthropic`          | `ANTHROPIC_API_KEY` | Claude models       |

**DeepSeek** is reached by setting `DEEPSEEK_API_KEY` in the environment and
selecting it explicitly:

```bash
export DEEPSEEK_API_KEY=sk-...
j-rig eval ./my-skill --spec ./eval-spec.yaml --provider deepseek
```

The DeepSeek adapter is the shared OpenAI-Chat-Completions adapter pointed at the
DeepSeek endpoint and the `deepseek-v4-flash` model — no DeepSeek-specific SDK is
required.

### Provider failure boundary

A provider failure is evidence about the evaluator, not a skill grade. If any
functional or judge call fails, `j-rig eval` records no verdict for that model
and still emits a `gate-result/v1` row with `gate_decision: "error"`, the error
class first in `gate_reasons`, and credential-free `metadata.error_detail`. The
SQLite run is marked `failed`, the `--json` result carries `gate_decision:
"error"` plus `evaluation_error`, and the process exits 2 after writing every
artifact. HTTP 402 and messages such as `Insufficient Balance` are classified as
non-retryable quota failures. A completed response with empty text is still
retained as a tool-dependent boundary observation, and `--samples` of 2 or more
absorbs transient judge failures through the agreement vote. See
[`000-docs/037-AT-SPEC-real-provider-failure-boundary-2026-08-02.md`](../../000-docs/037-AT-SPEC-real-provider-failure-boundary-2026-08-02.md).

A built-in `stub` provider exists for pipeline plumbing only. It is gated behind
`J_RIG_ALLOW_STUB=1` and its results are **not** ground truth.

## License

Apache-2.0 © Jeremy Longshore / Intent Solutions
