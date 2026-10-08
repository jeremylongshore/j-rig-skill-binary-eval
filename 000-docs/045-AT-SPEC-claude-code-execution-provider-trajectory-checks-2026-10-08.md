# 045 AT-SPEC: Claude Code execution provider and trajectory checks

**Status:** Implemented, 2026-10-08.
**Bead:** dn6j.1 (Give J-Rig a Claude Code execution provider that records tool calls and produced files).
**Origin:** whiteglove-pdf `000-docs/010-TQ-QAPL-iep-test-plan.md` § 6, gap 1.

## Problem

Every J-Rig execution provider sent one chat completion with `SKILL.md` as the
system prompt. The output carried text only: `tool_calls: 0` and `artifacts: []`
were hard-coded. A skill whose job is to produce a file, or to call tools in a
required order, could not be graded by J-Rig at all. whiteglove-pdf built its own
local lane (`evals/harness/claude_p.mjs`, `evals/trajectory_grade.py`) to work
around it.

## What ships

### 1. `--execution-provider claude-code`

`j-rig eval <skill> --execution-provider claude-code` swaps only the execution
leg. Trigger and judge stay on `--provider`, the same decoupling
`--judge-provider` gives the judge leg. Each test case runs once in real Claude
Code:

```text
claude -p <prompt> --model <model> --output-format stream-json --verbose \
  --setting-sources project --strict-mcp-config --no-session-persistence \
  --tools <list> --allowedTools <list> --max-budget-usd <usd>
```

The per-case temp directory holds:

| Path | Contents |
|---|---|
| `ws/` | Agent cwd. `--workspace-fixtures <dir>` is copied in, then the case's `context_hints.workspace_files` (relative path to text). |
| `ws/.claude/skills/<name>/` | A copy of the skill dir (no dotfiles such as `.git`, `.env`, `.npmrc`, `.venv`; no `node_modules` or `__pycache__`; symlinks refused). Omitted for the naked baseline, which passes an empty skill body. |
| `home/` | `HOME` and `CLAUDE_CONFIG_DIR` of the agent. |
| `home/.claude/.credentials.json` | The subscription access token only. The refresh token and every MCP OAuth token are dropped. |

The directory is deleted after the case unless `--keep-workspaces` is passed.

**Isolation, stated honestly.** This is workspace isolation, not an OS sandbox.
The agent runs as the invoking user, keeps that user's network access and
`PATH`, and a shell command can still reach absolute paths. What it does not get: the user's settings, `CLAUDE.md`, skills, plugins,
hooks, MCP servers or session history; any environment variable outside the
allowlist (`PATH`, `LANG`, `LC_*`, `TZ`, `TERM`, `TMPDIR`, `USER`, `LOGNAME`,
`SHELL`); or the refresh token. Without the refresh token a case can never
rotate, and so never invalidate, the user's real login. The run is refused when
the access token expires within the case budget plus 60 s.

### 2. Billing rule: subscription only, never an API key, never live in CI

The provider:

1. refuses to construct when any conventional CI marker is truthy (`CI`,
   `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `BUILDKITE`, `JENKINS_URL`,
   `TF_BUILD`, `TEAMCITY_VERSION`, `BITBUCKET_BUILD_NUMBER`,
   `CODEBUILD_BUILD_ID`, `DRONE`, `TRAVIS`);
2. strips every `ANTHROPIC_*` variable (the allowlist drops them);
3. kills the run and refuses when the stream's `init` event reports any
   `apiKeySource` other than `none`.

CI exercises the stream parser, the provider and the trajectory checks against
**recorded transcripts** replayed by a test double
(`packages/cli/src/providers/__fixtures__/claude-code/fake-claude.mjs`). Two
transcripts were recorded locally on the subscription with `haiku` (about
US$0.004 API-equivalent in total, not billed) and scrubbed: the temp root became
`__ROOT__`, uuids were renumbered, account rate-limit events were dropped, and
the init event was cut to the fields the parser reads (its `skills` list holds
only the skill under test).

### 3. Per-case budget

| Budget | Flag | Default | Enforced by |
|---|---|---|---|
| Wall clock | `--claude-code-timeout-ms` | 300000 | J-Rig: SIGTERM, then SIGKILL after 2 s, to the whole process group |
| Assistant turns | `--claude-code-max-turns` | 25 | J-Rig, live: distinct assistant message ids in the stream |
| API-equivalent dollars | `--claude-code-max-budget-usd` | 1 | Claude Code's `--max-budget-usd` |

Defaults are applied at runtime, never as schema defaults. A case that exhausts
any budget is **not completed**: it carries an error, is never judged, and the
model's row is signed `error` under the infrastructure-failure rule (`037`).
Grading a truncated trajectory would let `tool_not_called` pass on a run that
was cut short.

### 4. Trajectory

`ExecutionOutput.trajectory` (`j-rig/trajectory/v1`, `packages/core/src/execution/trajectory.ts`):

- `steps`: every `tool_use` in stream order: tool name, a deterministic input
  summary (Bash → command; Read/Write/Edit → file path; Glob/Grep → pattern;
  Skill → skill name; anything else → key-sorted JSON), workspace paths made
  relative, credential-shaped substrings redacted with core's provider-error
  rules (`redactCredentials`), truncated to 2,000 characters, and `is_error` when the tool result
  came back as an error.
- `files`: the post-run workspace manifest (excluding `.claude/`), each file with
  sha256, size, and `created`, `modified`, `unchanged` or `deleted`.
- `turns`, `stop` (`completed`, `error`, `max_turns`, `timeout`, `budget`,
  `no_result`).

`tool_calls` is now the real step count. `artifacts` lists every created or
modified file: text up to 256 KiB inline, anything else as `sha256:<hex>`.
Token usage (prompt tokens include cache creation and cache reads) and Claude
Code's `total_cost_usd` land in the case `meta`, feed the eval cost meter under
`claude-code/<model>`, and appear per case in the JSON output's `trajectories`.

The parser (`packages/cli/src/providers/claude-code-stream.ts`) is pure: same
bytes in, same trajectory out, regardless of how stdout was chunked. A non-JSON
line is counted, not fatal. A CLI that exits without a `result` event is a typed
`ProviderError` (`authentication` when stderr says so), not skill behavior.

### 5. Trajectory checks

Five deterministic checks, used as ordinary `method: deterministic` criteria.
Their params are validated by `CriterionSchema` at spec load, so a typo fails
`j-rig validate` before any spend.

| `deterministic_check` | `deterministic_check_params` | Passes when |
|---|---|---|
| `tool_called` | `tool`, `input_contains?`, `min_count?` | at least `min_count` (default 1) matching calls |
| `tool_not_called` | `tool`, `input_contains?` | no matching call |
| `order_before` | `first: {tool, input_contains?}`, `then: {…}` | both occur and the first `first` precedes the first `then` |
| `file_exists` | exactly one of `path` / `pattern`, `produced?` | a matching, non-deleted file exists (and was created or modified, with `produced: true`) |
| `file_matches_sha_in` | exactly one of `path` / `pattern`, `in` | every matching file's sha256 appears in `in`, a text file the run produced; `{path}` in `in` expands to the matched path |

`tool` matches exactly and is case-sensitive. `input_contains` matches the input
summary, which is truncated at 2,000 characters: a discriminator past that point
in a very long command is not visible to the check. Every check fails closed when the
outcome has no trajectory: a single-completion provider cannot observe tools, so
"no tool was called" must not pass vacuously. Every check also fails closed when
the trajectory's `stop` is not `completed`. `j-rig eval` never judges such a
case anyway (it carries `output.error`, so `isFailedExecution` skips it and
`detectInfrastructureFailure` signs the row `error`); the check-level refusal
covers any other caller of the judgment engine.

A symlink the agent creates is recorded in the manifest with
`sha256(symlink:<target>)` and appears in `artifacts` as an empty text entry;
its target is visible only through that manifest hash.

Example (from the live smoke run):

```yaml
criteria:
  - id: write-before-sum
    description: The report is written before its receipt is computed.
    method: deterministic
    deterministic_check: order_before
    deterministic_check_params:
      first: { tool: Write }
      then: { tool: Bash, input_contains: sha256sum }
  - id: receipt-matches
    description: The receipt records the report's sha256.
    method: deterministic
    deterministic_check: file_matches_sha_in
    deterministic_check_params: { path: report.md, in: "{path}.sha256" }
```

## Verification

- Unit and replay tests: `claude-code-stream.test.ts` (parser over both recorded
  transcripts, chunking invariance, damaged input), `claude-code.test.ts`
  (provider end to end through the test double: trajectory, manifest, artifacts,
  usage, env allowlist, access-only credential, naked baseline, symlink and path
  refusals, CI refusal, API-key refusal, token-expiry refusal, wall-clock and turn
  budgets, crash mapping, flag resolution), `trajectory-checks.test.ts` (each
  check, fail-closed paths, schema validation, engine integration).
- Live smoke, local subscription: a five-criterion trajectory spec against a
  receipt-writing skill on `haiku` graded 5/5 through `j-rig eval
  --execution-provider claude-code --provider stub --no-trigger`.

## Out of scope, and where it is tracked

- The kernel eval-case schema lives in intent-eval-core. The checks above are
  expressed through the existing open `deterministic_check` /
  `deterministic_check_params` fields, so the kernel adapter projects them
  unchanged. Promoting them to typed kernel assertions is filed as a bead under
  the dn6j epic, not done here.
- Temperature: Claude Code exposes no sampling temperature, so
  `execution_temperature` does not apply to this provider.
- whiteglove-pdf's domain checks (receipt status, theme, the email send gate)
  stay in whiteglove. Its generic harness (`claude_p.mjs`) and the generic
  order and file checks can move onto this provider once a jrig-cli release
  carries it.
