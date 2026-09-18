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
j-rig run --task ... --config ...     # generic shell-free task/config raw Run
j-rig grade --run-id ... --grader ... # named immutable Grade over a completed Run
j-rig report                         # show results from the SQLite evidence DB
j-rig optimize                       # cluster failures, propose one change
j-rig drift                          # check whether a skill needs reevaluation
j-rig emit-evidence                  # wrap a gate-result into a signed Statement
j-rig migrate <dir>                  # codemod v0.1.0-draft → gate-result/v1
j-rig refine                         # eval-guided SKILL.md improvement loop
```

`j-rig eval <skill-dir>` expects an `eval-spec.yaml` (or `--spec <path>`) and
writes evidence to a local SQLite DB (`--db <path>`, default `j-rig.db`).

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

A built-in `stub` provider exists for pipeline plumbing only. It is gated behind
`J_RIG_ALLOW_STUB=1` and its results are **not** ground truth.

## License

Apache-2.0 © Jeremy Longshore / Intent Solutions
