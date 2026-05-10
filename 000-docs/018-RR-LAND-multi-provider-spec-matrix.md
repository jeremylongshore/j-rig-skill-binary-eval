---
title: "Multi-Provider Spec Matrix — Landscape Mapping for Vendor-Neutral Evaluation"
date: 2026-05-10
status: "Draft v1.0 — Part 2 research deliverable"
category: RR-LAND
project: j-rig-binary-eval
classification: internal
---

# Multi-Provider Spec Matrix — Landscape Mapping for Vendor-Neutral Evaluation

**Author:** Jeremy Longshore (Intent Solutions)
**Date:** 2026-05-10
**Status:** Draft v1.0 — Part 2 research deliverable
**Sibling docs (three-repo convergence):**
- `intent-eval-platform/intent-eval-lab/specs/mcp-plugin-observability/v0.1.0-draft/` — vendor-neutral methodology spec
- `intent-eval-platform/audit-harness/` — deterministic enforcement package
- `intent-eval-platform/j-rig-binary-eval/` — judgment / eval harness (this repo)

---

## 1. Mission & scope

j-rig is a binary-eval harness for agent skills: every criterion resolves yes or no, blocker criteria gate release, judge LLMs replace gradient scoring. **The harness is currently Claude-bound** — `ModelTarget` hardcodes `haiku | sonnet | opus`, 20+ check IDs are prefixed `anthropic:`, the only provider implementation under `packages/cli/src/providers/` is `anthropic.ts`, and `references/specs/` snapshots only the Anthropic + AgentSkills.io specs.

The three-repo convergence vision treats j-rig as one leg of a methodology stack alongside `audit-harness` (deterministic enforcement) and `intent-eval-lab` (vendor-neutral methodology specs). For that convergence to be credible, **j-rig has to be able to judge skills authored against any agentic CLI's spec, not just Anthropic's.** That means an explicit landscape map of what each major vendor's spec surface looks like, what's observable, what's borrowable from existing OSS leaders, and what concrete Phase B work items move j-rig out of its Claude binding.

This document **maps the landscape only.** It does not propose a framework choice, does not select an abstraction library, and does not include implementation code. The Phase B recommendations in § 9 are deliberately scoped to "what gates the next decision," not "here's what to build."

---

## 2. Empirical anchor — current j-rig binding surface

Grep counts and file paths in this section reflect the repo as of 2026-05-10. They establish the empirical baseline that any vendor-neutral migration is measured against.

### 2.1 Claude binding — what's hardcoded

| File | Lines | Binding | Cite |
|---|---|---|---|
| `packages/core/src/schemas/eval-spec.ts` | 52 | `ModelTarget = z.enum(["haiku", "sonnet", "opus"])` + `.default(["sonnet"])` | line 8, line 43 |
| `packages/core/src/schemas/skill-frontmatter.ts` | 93 | `SkillModel = z.enum(["inherit", "sonnet", "haiku", "opus"])` | line 6 |
| `packages/cli/src/commands/eval.ts` | (full) | CLI option default `"sonnet"` | line 70 |
| `packages/cli/src/commands/validate.ts` | (full) | Fallback `["sonnet"]` for missing model field | line 75 |
| `packages/core/src/schemas/eval-spec.test.ts` | (full) | Three assertions against `"sonnet"` model default | lines 24, 84, 92 |
| `packages/cli/src/providers/anthropic.ts` | 82 | Only provider implementation; classes `StubTriggerProvider`, `StubExecutionProvider`, `StubJudgeProvider` all named `…Anthropic`-adjacent in directory layout but stub-only — no real Anthropic SDK call yet | full file |
| `packages/core/src/checks/package-checker.ts` | 396 | Six check IDs prefixed `anthropic:` (`anthropic:name-no-xml`, `anthropic:description-no-xml`, `anthropic:no-time-sensitive`) | lines 320, 327, 336, 343, 365, 378 |
| `packages/core/src/governance/spec-sources.ts` | 192 | Loads two snapshots: `anthropic-skills-spec.md` and `agentskills-spec.md`. `SpecAuthority.anthropicRequiredFields = ["name", "description"]` | lines 87, 140-165 |

### 2.2 Grep verification (run from repo root)

```
$ rg -c "haiku|sonnet|opus|ModelTarget|anthropic:" --type ts
packages/cli/src/commands/eval.ts:1
packages/cli/src/commands/validate.ts:1
packages/core/src/schemas/eval-spec.test.ts:3
packages/core/src/schemas/index.ts:1
packages/core/src/schemas/skill-frontmatter.ts:1
packages/core/src/schemas/eval-spec.ts:4
packages/core/src/checks/package-checker.ts:6
packages/core/src/governance/spec-sources.ts:5
                                              # 22 hits across 8 files

$ rg -c "openai|gemini|codex|cursor|windsurf|copilot|continue.dev|aider|cline" --type ts -i
                                              # 0 hits — total absence
```

### 2.3 What is provider-neutral already

Not everything is bound. These surfaces are already vendor-neutral:

- **`CriterionSchema`** (`packages/core/src/schemas/criterion.ts`, 45 lines) — `method: "deterministic" | "judge"`, `blocker`, `regression_critical`, `baseline_sensitive`, `pack_sensitive`. No model references.
- **`TriggerProvider` / `ExecutionProvider` / `JudgeProvider` interfaces** (`packages/core/src/{trigger,execution,judgment}/types.ts`) — interface signatures are vendor-agnostic. They accept a `model: string` option but don't constrain it. The hardcoding is in the schema layer, not the provider interface layer.
- **Deterministic check registry** (`packages/core/src/checks/deterministic-registry.ts`) — pluggable check IDs. The check *bodies* in `package-checker.ts` carry the `anthropic:` prefix; the registry mechanism itself is generic.

**This means the migration is a schema-and-prefix rewrite, not an interface redesign.** Phase B § 9 work items are sized accordingly.

---

## 3. Per-vendor spec dossiers

One subsection per major agentic CLI. Each dossier covers: current version, primary URLs, spec surface (DSL / instructions file / frontmatter), observable behaviors a vendor-neutral evaluator could test against, and the spec primitives j-rig would need to understand to judge a skill authored for that vendor.

### 3.1 Anthropic — Claude Code

| Field | Value |
|---|---|
| **Spec home** | https://code.claude.com/docs/en/skills |
| **Related** | https://code.claude.com/docs/en/plugins · https://code.claude.com/docs/en/hooks · https://code.claude.com/docs/en/mcp · https://docs.anthropic.com/en/api/agent-skills |
| **Instructions file** | `SKILL.md` (per skill directory) + `CLAUDE.md` (per project) |
| **Format** | YAML frontmatter + Markdown body |
| **Required frontmatter** | `name`, `description` (only) |
| **Notable optional fields** | `allowed-tools`, `model`, `effort` (`low|medium|high|xhigh|max`), `argument-hint`, `arguments`, `paths` (glob), `context: fork`, `agent`, `hooks`, `shell` (`bash|powershell`), `when_to_use`, `disable-model-invocation`, `user-invocable` |
| **Activation modes** | Always-on description, model-invoked via description match, user-invoked via `/skill-name`, path-glob auto-trigger |
| **String substitution** | `$ARGUMENTS`, `$N`, `$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_EFFORT}` |
| **Dynamic context injection** | `` !`<command>` `` (preprocessed before model sees content) |
| **MCP** | First-class. `code.claude.com/docs/en/mcp` documents `.mcp.json` and `mcpServers` field of `plugin.json`. Tool prefix `mcp__<server>__<tool>` is observable. |
| **Hooks** | First-class. ~30 event types, `hooks/hooks.json`, deterministic enforcement layer per Kobiton M2 thesis. |
| **Observable behaviors** | Skill activation (description match), tool calls (`mcp__*`, `Bash`, `Read`, etc.), file references via `${CLAUDE_SKILL_DIR}/...`, hook firing, OTel emission (`claude_code.skill_activated`, `claude_code.tool`, `claude_code.hook`) — but most OTel signals are gated on `CLAUDE_CODE_ENABLE_TELEMETRY=1` and detailed traces need `ENABLE_BETA_TRACING_DETAILED=1`. |
| **Models referenced** | `inherit`, `opus`, `sonnet`, `haiku` (shorthand); full IDs accepted but not recommended. |
| **j-rig already covers?** | Yes — this is what's bound today. |

### 3.2 OpenAI — Codex CLI

| Field | Value |
|---|---|
| **Spec home** | https://github.com/openai/codex (Apache-2.0, Rust 96%) |
| **Current version** | v0.130.0 (2026-05-08) |
| **Instructions file** | `AGENTS.md` (repo root + nested per-directory; closest wins) |
| **Format** | Pure Markdown — **no required frontmatter**. Just headings. |
| **Required frontmatter** | None |
| **Function-calling format** | OpenAI Chat Completions / Responses API `tools` array; `tool_calls` response shape with `id`, `function.name`, `function.arguments`. Strict mode opt-in. Parallel tool calls supported. |
| **MCP** | Supported (Codex CLI ships with MCP client). |
| **Configuration directory** | `.codex/` (per the repo's top-level layout — exact schema not yet published on the canonical doc page) |
| **Authentication** | ChatGPT account OR `OPENAI_API_KEY` |
| **Observable behaviors** | File creation / modification, tool-call sequences, plan tracking (Codex emits multi-step plans), terminal-command execution. Codex archives an action log per session. |
| **Spec primitives evaluators need** | (a) AGENTS.md presence + heading conventions ("Setup", "Test", "Build"), (b) function-calling tool schema validation, (c) MCP server config (if present), (d) deterministic action-log replay for assertions. |
| **j-rig coverage gap** | Total. `AGENTS.md` parsing not implemented; OpenAI tool schema not validated; no Codex action-log adapter. |

### 3.3 Google — Gemini CLI

| Field | Value |
|---|---|
| **Spec home** | https://github.com/google-gemini/gemini-cli |
| **Current version** | v0.41.2 (2026-05-06) — weekly stable cadence (Tuesdays UTC) |
| **Instructions file** | `GEMINI.md` (project context) + `.geminiignore` (scope) — also recognizes `AGENTS.md` per the open standard |
| **Format** | Markdown |
| **Function-calling format** | Gemini API function-declarations (JSON-schema-ish; differs from OpenAI in `parameters` vs `inputSchema` naming) |
| **MCP** | First-class. Configured via `~/.gemini/settings.json`. `@github`, `@slack`, `@database` prefix syntax. External MCP servers for Imagen, Veo, Lyria. |
| **Authentication** | OAuth Google account (free tier 60 req/min, 1000/day) OR API key OR Vertex AI |
| **Input modes** | Interactive REPL, non-interactive `-p`, scripting |
| **Output formats** | Text (interactive), JSON (`--output-format json`), newline-delimited stream-JSON (`--output-format stream-json`) — **machine-readable output is first-class, great for eval harness consumption** |
| **Models** | `gemini-3-flash`, `gemini-3-pro`, 1M-token context |
| **Observable behaviors** | Conversation checkpointing (save/resume), token cache hit metrics, slash commands (`/help`, `/chat`), file ops, shell exec, web search grounding, stream-JSON event stream |
| **Spec primitives evaluators need** | (a) `GEMINI.md` parsing, (b) function-declaration schema validation, (c) MCP config validation (different syntax than Anthropic), (d) stream-JSON event taxonomy as observable signal source. |
| **j-rig coverage gap** | Total. Of all vendors, Gemini's `--output-format stream-json` is the easiest to consume from a TypeScript eval harness — it's a structured event stream. |

### 3.4 Cursor

| Field | Value |
|---|---|
| **Spec home** | https://cursor.com/docs (canonical URL after 2026 redirect from `docs.cursor.com`) |
| **Instructions files** | `.cursorrules` (legacy, deprecated) + `.cursor/rules/*.mdc` (current, ≥ v0.45) |
| **Format** | `.mdc` = YAML frontmatter + Markdown body |
| **Frontmatter fields** | `description`, `globs`, `alwaysApply` |
| **Rule activation modes** | **Four explicit types**: (a) **Always Apply** (`alwaysApply: true` — loads every conversation), (b) **Auto Attached** (`globs` match — loads when file in glob is touched), (c) **Agent Requested** (description-based; agent decides to load), (d) **Manual** (`@rule-name` mention) |
| **Reverse-engineered note** | Per community forum threads, the schema is partially undocumented; `RULE.md`-folder format doesn't work despite docs implying it should — only `.mdc` files in `.cursor/rules/` are loaded. Brittle. |
| **MCP** | Supported; configured via `.cursor/mcp.json`. |
| **Tool-call format** | Cursor exposes editor primitives (read_file, edit_file, run_terminal) plus MCP tools to the agent; not openly documented as a JSON schema — inferred via reverse engineering. |
| **Observable behaviors** | Rule attachment (visible in chat sidebar), tool invocations, file edits via diff view, agent vs ask vs plan modes |
| **Spec primitives evaluators need** | (a) `.mdc` frontmatter parser with the four activation modes, (b) glob-match resolver, (c) `.cursor/mcp.json` parser. |
| **j-rig coverage gap** | Total. The four activation modes are *structurally* similar to Anthropic's (`alwaysApply` ≈ description-always, `globs` ≈ `paths`, agent-requested ≈ description-match, `@`-mention ≈ `disable-model-invocation: true`) — borrowable as a parallel schema. |
| **Stability concern** | Schema is undocumented and partially broken (forum-confirmed); j-rig should snapshot a known-working `.mdc` shape and refresh quarterly the same way `references/specs/anthropic-skills-spec.md` is refreshed. |

### 3.5 Windsurf (Codeium Cascade)

| Field | Value |
|---|---|
| **Spec home** | https://docs.windsurf.com/windsurf/cascade/memories |
| **Two-layer model** | **Rules** (user-defined, version-controlled, durable) + **Memories** (auto-generated, machine-local, ephemeral) |
| **Rule scopes** | Global (`~/.codeium/windsurf/memories/global_rules.md`, 6000 char cap) · Workspace (`.windsurf/rules/*.md`, 12000 char/file) · Directory (`AGENTS.md`, no cap) · System enterprise (OS-specific, read-only) |
| **Frontmatter** | YAML in `.windsurf/rules/*.md` with `trigger:` field |
| **Activation modes (`trigger:` values)** | `always_on`, `model_decision`, `glob`, `manual` (`@rule-name`) |
| **MCP** | Not addressed in current public docs. |
| **Observable behaviors** | Auto-memory creation, rule retrieval (visible in UI), workspace isolation, deduplication across multi-open-folders |
| **Spec primitives evaluators need** | (a) Frontmatter parser with the four trigger modes, (b) scope-precedence resolver (global / workspace / system), (c) char-cap validator. |
| **j-rig coverage gap** | Total. Windsurf's `trigger:` field is **the closest analog to Cursor's `alwaysApply + globs + agent-requested + manual` quartet** — a vendor-neutral schema should harmonize these. |

### 3.6 GitHub — Copilot CLI (`gh copilot`)

| Field | Value |
|---|---|
| **Spec home** | https://github.com/github/gh-copilot (archived 2025-10-30) |
| **Status** | **Deprecated / archived.** Successor: a separate "GitHub Copilot CLI" agentic harness referenced in Copilot docs. |
| **Current surface (legacy)** | `gh copilot suggest`, `gh copilot explain` — not agentic; advisory only. |
| **Configuration** | `gh copilot config` (analytics opt-in, command-execution confirmation) |
| **Custom rules** | None (legacy CLI was advisory; no AGENTS.md, no MCP) |
| **Successor** | The "agentic harness that powers Copilot coding agent" — but no public CLI spec page yet. AGENTS.md is recognized by Copilot Coding Agent per agents.md ecosystem list. |
| **j-rig coverage decision** | **Skip until the successor's public spec lands.** Evaluating the deprecated `gh copilot` advisory CLI has no Phase B ROI. Plan for Copilot Coding Agent coverage when its spec stabilizes. |
| **Observable behaviors** | (Legacy) command suggestion text, shell-alias execution path. (Successor) Unknown — gated on public docs. |

### 3.7 Continue.dev

| Field | Value |
|---|---|
| **Spec home** | https://github.com/continuedev/continue (Apache-2.0, 21,498+ commits) |
| **Distribution** | VS Code + JetBrains extension + `cn` CLI |
| **Configuration** | `config.yaml` (modern) or `config.json` (legacy) — model providers + role-based assignment (chat vs autocomplete) |
| **Custom rules** | Markdown checks in `.continue/checks/` directories; natural-language directives (security review, lint, etc.) |
| **Slash commands** | Supported; templated prompts |
| **Providers** | OpenAI, Anthropic, Microsoft/Azure, Mistral, self-hosted (Ollama, LM Studio), Hub-managed |
| **MCP** | First-class via Agent mode + "MCP Servers" feature |
| **AGENTS.md** | Recognized per the open standard |
| **Observable behaviors** | Tool calls, slash-command templates, role-based model dispatch, hub vs local config split |
| **Spec primitives evaluators need** | (a) `config.yaml` schema (models, roles, rules, MCP), (b) `.continue/checks/*.md` parser, (c) hub-config vs local-config resolution. |
| **j-rig coverage gap** | Total. Continue's `role`-based model assignment is unique among the surveyed vendors — autocomplete vs chat use different models — and an evaluator that judges "did the right role's model handle this" is a real differentiator. |

### 3.8 Aider

| Field | Value |
|---|---|
| **Spec home** | https://aider.chat/ · https://github.com/Aider-AI/aider (Apache-2.0) |
| **Leaderboard / benchmark** | https://aider.chat/docs/leaderboards/ — **Aider already has multi-provider eval working.** Polyglot benchmark = 225 Exercism exercises × 6 languages (C++, Go, Java, JS, Python, Rust). |
| **Provider abstraction** | **Aider uses LiteLLM under the hood.** This is the canonical OSS proof-point that LiteLLM is production-ready for cross-provider eval. |
| **Tested vendors on leaderboard** | OpenAI (gpt-5, gpt-4.1, gpt-4o, ChatGPT-4o, o1, o3-mini), Anthropic (Claude 3.5/3.7 Sonnet, Opus 4, thinking variants), Google (Gemini 2.5 Pro/Flash), DeepSeek (V3, R1), xAI (Grok 3/4), Meta (Llama 4 Maverick), Qwen, Cohere Command, Codestral, QwQ-32B |
| **Metrics reported** | pass@1, pass@2, edit-format correctness %, total cost, malformed-response count, context-exhaustion count, seconds-per-case, prompt+completion tokens |
| **Edit formats tested** | `diff`, `diff-fenced`, `architect` (two-model), `whole` |
| **Repo-wide instructions** | `CONVENTIONS.md` (Aider-native, predates AGENTS.md), now recognizes AGENTS.md too |
| **Configuration** | `.aider.conf.yml` + per-model settings file |
| **j-rig coverage gap** | Partial — Aider's edit-format + pass@N + cost metric template is **directly borrowable as j-rig's per-vendor reporting layout.** This is the most concrete OSS leader to study for Phase B. |

### 3.9 Cline

| Field | Value |
|---|---|
| **Spec home** | https://github.com/cline/cline (Apache-2.0 © 2026) |
| **Distribution** | VS Code extension |
| **Providers** | Anthropic, OpenAI, Google Gemini, AWS Bedrock, Azure, GCP Vertex, Cerebras, Groq, OpenRouter, Ollama, LM Studio, any OpenAI-compatible API |
| **Provider routing pattern** | Direct SDK + adapter pattern (verified by Cline community; not officially documented as LiteLLM-based) |
| **Custom rules** | `.clinerules/` directory; format reverse-engineered (no canonical doc) |
| **MCP** | First-class. Cline can **autonomously create MCP servers** ("add a tool that..." → Cline builds + installs an MCP server). Major spec-conformance test target. |
| **Configuration** | `settings.json` (schema not publicly documented) |
| **Observable behaviors** | Per-tool approval gate (visible UI), diff-view file edits, Timeline-tracked changes, linter/compiler error self-fix loop, terminal feedback loop |
| **Plan / Act modes** | Not explicit per docs; iterative reactive flow rather than two-phase planning |
| **j-rig coverage gap** | Total. Cline's MCP-server-autogeneration behavior is a behavioral eval primitive worth testing — but the lack of a canonical config schema makes it more fragile than other targets. |

---

## 4. Open-standard dossiers

The three normative standards that cut across multiple vendors.

### 4.1 AgentSkills.io

| Field | Value |
|---|---|
| **Spec home** | https://agentskills.io/specification |
| **Governance** | Open standard; reference implementation at `github.com/agentskills/agentskills` (skills-ref validator) |
| **Required frontmatter** | `name`, `description` |
| **Optional frontmatter** | `license`, `compatibility` (max 500 chars), `metadata` (arbitrary key-value), `allowed-tools` (experimental) |
| **Directory layout** | `SKILL.md` (required) + optional `scripts/`, `references/`, `assets/` |
| **Progressive disclosure model** | (a) Metadata ~100 tokens at startup, (b) Instructions <5000 tokens on activation, (c) Resources on demand |
| **Body content rules** | No format restrictions; recommended sections (steps, examples, edge cases) |
| **Vendors declaring support** | Claude Code (explicit superset), Codex CLI, Aider, others |
| **j-rig coverage** | Yes — `references/specs/agentskills-spec.md` snapshot present. |
| **Note** | AgentSkills.io is the **base spec**; Anthropic's Claude Code spec is the **richest superset** (adds 14+ optional fields like `hooks`, `paths`, `context: fork`, `effort`, `model`, `argument-hint`, substitution variables). j-rig's `SpecAuthority` already models this layering — easy to extend with per-vendor superset descriptors. |

### 4.2 AGENTS.md

| Field | Value |
|---|---|
| **Spec home** | https://agents.md/ |
| **Format** | Plain Markdown — **no frontmatter required.** Conventional H2/H3 sections (Setup, Test, Build, Style). |
| **Location** | Repo root + nested per-directory (closest wins for monorepos) |
| **Tools recognizing AGENTS.md** | OpenAI Codex, Google Jules, Gemini CLI, Factory, Aider, GitHub Copilot Coding Agent, VS Code, Cursor, Zed, JetBrains Junie, Windsurf, Devin, goose, opencode, Warp, Semgrep, RooCode, Kilo Code, Phoenix, Augment Code, Ona, UiPath Autopilot |
| **Anthropic Claude Code status** | Not on the official AGENTS.md compatibility list, but the broader Anthropic ecosystem has the Kobiton M2 Blog 1 thesis treating AGENTS.md as the cross-tool plugin standard (see `kobiton/000-docs/018-DR-BLOG-content-9-agents-md.md`). |
| **Normative behavior** | (a) Markdown heading parsing, (b) automatic execution of listed programmatic checks, (c) directory-proximity precedence, (d) user chat overrides file. |
| **j-rig coverage gap** | Total. AGENTS.md is **the lowest-common-denominator across most vendors** — Phase B should make AGENTS.md a first-class parsing target alongside Anthropic SKILL.md. |

### 4.3 MCP (Model Context Protocol)

| Field | Value |
|---|---|
| **Spec home** | https://modelcontextprotocol.io/specification |
| **Current spec version** | 2025-11-25 (TypeScript schema-anchored) |
| **Transport** | JSON-RPC 2.0 over stdio · HTTP · SSE · WebSocket |
| **Server-offered features** | Resources (context/data), Prompts (templated workflows), Tools (functions for the model to call) |
| **Client-offered features** | Sampling (server-initiated LLM call), Roots (filesystem boundaries), Elicitation (user prompts) |
| **Utilities** | Configuration, Progress, Cancellation, Error reporting, Logging |
| **Vendors that implement MCP** | Anthropic Claude Code, Cursor, Cline, Continue.dev, Gemini CLI, Codex CLI, more |
| **Security primitives** | User consent + control, data privacy, tool safety, LLM sampling controls — all defined as `SHOULD` per RFC 2119 |
| **Observable behaviors a tester could check** | (a) `initialize` capability negotiation, (b) `tools/list` enumeration, (c) `tools/call` invocations, (d) `resources/read` returns, (e) `prompts/get` shapes, (f) `logging/message` events |
| **j-rig coverage gap** | Currently zero — `references/specs/mcp-spec.md` does not exist. Phase B § 9 should add an MCP snapshot. This is **shared across every vendor** that implements MCP, so the conformance check is reusable. |

---

## 5. Provider-coverage matrix

Rows = vendors. Columns = capability dimensions. ✓ = supported and observable. ✗ = not supported. ◐ = supported but undocumented / unstable / reverse-engineered. **— = N/A.** **j-rig today** row at the bottom shows what j-rig actually validates.

| Vendor | Instructions DSL | Frontmatter spec | Activation modes | Tool-call format | MCP integration | Hooks | OTel emission | AGENTS.md recognized | j-rig parse target? |
|---|---|---|---|---|---|---|---|---|---|
| **Anthropic Claude Code** | `SKILL.md` (YAML+MD) | ✓ rich (16 fields) | ✓ 4 modes (auto / user / path-glob / agent-fork) | ✓ Anthropic tool-use API | ✓ `.mcp.json` | ✓ `hooks/hooks.json` (~30 events) | ✓ `claude_code.*` family (gated) | ◐ (not officially listed) | ✓ today |
| **OpenAI Codex CLI** | `AGENTS.md` (pure MD) | ✗ none | ◐ heading-implicit | ✓ OpenAI function-calling | ✓ | ✗ | ✗ | ✓ | ✗ |
| **Google Gemini CLI** | `GEMINI.md` + `AGENTS.md` | ✗ none | ◐ heading-implicit | ✓ Gemini function-declarations | ✓ `~/.gemini/settings.json` + `@prefix` | ✗ | ◐ (stream-JSON events) | ✓ | ✗ |
| **Cursor** | `.cursor/rules/*.mdc` (YAML+MD) | ◐ partial-doc 3 fields | ✓ 4 modes (always / glob / agent-req / manual) | ◐ editor primitives + MCP (undocumented schema) | ✓ `.cursor/mcp.json` | ✗ | ✗ | ✓ | ✗ |
| **Windsurf** | `.windsurf/rules/*.md` (YAML+MD) | ✓ `trigger:` field | ✓ 4 modes (always_on / model_decision / glob / manual) | ◐ undocumented | ✗ (not public) | ✗ | ✗ | ✓ | ✗ |
| **GitHub Copilot CLI** | (none — deprecated) | — | — | ✗ legacy advisory only | ✗ | ✗ | ✗ | ✓ (Coding Agent successor) | ✗ |
| **Continue.dev** | `config.yaml` + `.continue/checks/*.md` | ✓ (yaml schema) | ◐ role-based + globs | ✓ OpenAI-shape via providers | ✓ | ✗ | ✗ | ✓ | ✗ |
| **Aider** | `CONVENTIONS.md` + `AGENTS.md` | ✗ pure MD | — | ✓ via LiteLLM (any provider) | ✗ (CLI-only) | ✗ | ✗ | ✓ | ✗ |
| **Cline** | `.clinerules/` (undocumented) | ✗ | ◐ undocumented | ✓ direct SDK per provider | ✓ + autogeneration | ✗ | ✗ | ✓ | ✗ |
| **AgentSkills.io (base)** | `SKILL.md` (YAML+MD) | ✓ 6 fields | — | ◐ `allowed-tools` experimental | — | ✗ | ✗ | — | ✓ today |
| **AGENTS.md (open)** | `AGENTS.md` (pure MD) | ✗ none | — | — | — | — | — | (self) | ✗ |
| **MCP (cross-cutting)** | (server config) | ✓ JSON-RPC schema | — | ✓ `tools/call` | (self) | — | ✗ | — | ✗ |
| **— j-rig today —** | only Anthropic SKILL.md + AgentSkills.io | ✓ Anthropic 16, AgentSkills 6 | partial (description-match, path-glob) | ✗ (stub providers, no real exec) | ✗ (no MCP-conformance check) | ✗ | ✗ | ✗ | n/a |

**Reading the matrix:** the convergence target is to fill every cell in the `j-rig today` row with at least a parse-target box check. The row order in the priority recommendation in § 9 follows: AGENTS.md (broadest reach) → OpenAI / Gemini (largest install base after Anthropic) → MCP conformance (shared across half the vendors) → Cursor / Windsurf / Cline (IDE-flavor agents) → Continue.dev / Aider (smaller install but unique signal).

---

## 6. OSS leaders — provider-abstraction borrowability

Eight OSS projects studied for their provider-abstraction patterns. Each row carries license, the abstraction pattern, and what's specifically borrowable for j-rig's Phase B.

| # | Project | License | Stars (~) | Pattern | Borrowable for j-rig |
|---|---|---|---|---|---|
| 1 | **LiteLLM** (`BerriAI/litellm`) | MIT (core) + commercial (enterprise) | 14k+ | Unified `completion()` interface, 100+ providers, OpenAI-shape normalization, request/response/error mapping, streaming-iterator normalization, exception mapping, observability callbacks (Lunary, MLflow, Langfuse), router with retry/fallback, gateway proxy | **The replacement for `ModelTarget` enum.** Drop LiteLLM in `packages/cli/src/providers/`, replace `anthropic.ts` stubs with real LiteLLM-routed `completion()` calls. **Highest-ROI single change.** Aider already proves this works in production for cross-provider eval. |
| 2 | **Vercel AI SDK** (`vercel/ai`) | Apache-2.0 | 11k+ | TypeScript-native provider factory (`anthropic('claude-3.5')`, `openai('gpt-5')`), gateway routing via `'<provider>/<model>'` string, `streamText` / `generateText` / `generateObject` (Zod-schema-driven structured output), `ToolLoopAgent`, ~12 first-party providers | **Direct competitor to LiteLLM but TypeScript-native.** j-rig is a TS monorepo — Vercel AI SDK is the closest type-safety match. Best-of: pair Vercel AI SDK as the primary TS interface with LiteLLM gateway as a fallback for niche providers. |
| 3 | **Aider** (`Aider-AI/aider`) | Apache-2.0 | 25k+ | LiteLLM-based provider routing + per-language Exercism polyglot benchmark + pass@N + cost-per-run + edit-format-correctness metrics | **The reporting template.** Aider's leaderboard table format (pass@1, pass@2, edit-correct %, cost, malformed%, time/case, tokens) maps almost 1:1 onto j-rig's binary-criterion reporting + judge-confidence layer. Borrow the column shape. |
| 4 | **Cline** (`cline/cline`) | Apache-2.0 | 25k+ | Direct SDK per provider (not LiteLLM) + per-tool approval gate observable via UI + MCP server autogeneration + Timeline change tracking | **The MCP autogeneration behavior is a borrowable behavioral eval primitive.** If a Cline-equivalent skill is asked "add an MCP tool for X," does the resulting `.mcp.json` validate? That's a yes/no criterion — exactly j-rig's shape. |
| 5 | **OpenLLMetry / Traceloop** (`traceloop/openllmetry`) | Apache-2.0 | 6k+ | OpenTelemetry-for-LLMs spec (now upstreamed to OTel official semantic conventions); 15+ provider instrumentations (Anthropic, OpenAI, Bedrock, Gemini, Cohere, Ollama, Vertex, Mistral, etc.); vector-DB + framework instrumentation; 25+ observability-platform exporters | **The OTel semantic-convention layer.** When j-rig graduates from stub providers to real execution, every run should emit `gen_ai.*` spans. OpenLLMetry is the source of truth for the semantic conventions and ships drop-in instrumentations. Pairs with the Kobiton R3 § 6 OTel framing. |
| 6 | **Continue.dev** (`continuedev/continue`) | Apache-2.0 | 20k+ | `config.yaml` schema with role-based model assignment (chat vs autocomplete vs edit), Hub-managed vs local-config split, `.continue/checks/*.md` natural-language enforcement, MCP-first agent mode | **Role-based model assignment** is a unique primitive worth adopting in `EvalSpec`. j-rig currently lets you pick `models: [sonnet, opus]` for a whole skill. Continue's pattern is finer-grained: which model handles the `trigger` step, which handles the `judge` step, which handles `execution`. Already-half-implemented in j-rig's `TriggerProvider` / `ExecutionProvider` / `JudgeProvider` separation. |
| 7 | **Sourcegraph Cody** (`sourcegraph/cody`) | (404 on direct fetch — repo moved or archived; verify in Phase B) | — | (Skipped — could not verify shape during this landscape pass.) | (Skipped — Cody is the lowest-priority leader to follow up on; if archived, drop from the list and substitute with `LangChain` model abstraction.) |
| 8 | **LangChain** (`langchain-ai/langchain`) | MIT | 95k+ | Older but the reference for provider abstraction in Python; `BaseChatModel` interface, `LangChainSmith` for tracing, eval primitives in `langchain.evaluation` | **The reference for "how this was solved before LiteLLM."** Worth reading the `BaseChatModel` interface to understand the abstraction layering. Not borrowable wholesale — too Python-heavy for j-rig's TS monorepo — but informative. |
| 9 (bonus) | **AgentSkills skills-ref** (`agentskills/agentskills/skills-ref`) | (Apache-2.0, inferred) | (small) | Reference validator for AgentSkills.io spec | **Direct borrow** — j-rig already partially aligns. Snapshot the `skills-ref validate` rules into `references/specs/agentskills-spec.md` quarterly. Use as cross-check against j-rig's own enforcement. |

**Top 3 for Phase B borrowing (high confidence):**
1. **LiteLLM** — provider routing, 100+ providers in one library, Aider-proven.
2. **Vercel AI SDK** — TypeScript-native, type-safe, factory pattern, pair with LiteLLM as backbone.
3. **Aider leaderboard format** — direct template for j-rig's per-vendor reporting layer.

---

## 7. Borrowable patterns — concrete adoption candidates

Specific patterns extracted from § 6, each with the j-rig integration point.

| # | Pattern | Source | Where it lands in j-rig |
|---|---|---|---|
| 1 | **Unified `completion()` interface across providers** | LiteLLM | Replace `packages/cli/src/providers/anthropic.ts` stub trio with a single `litellm-provider.ts` that satisfies all three of `TriggerProvider` / `ExecutionProvider` / `JudgeProvider` via LiteLLM `completion()`. Model selection comes from new `EvalSpec.models[].vendor + model` shape (§ 9 item 1). |
| 2 | **Provider factory + model string `<vendor>/<model>`** | Vercel AI SDK | Convert `ModelTarget` from `z.enum(["haiku","sonnet","opus"])` to `z.string()` validated against a `VENDOR_MODELS` registry. Accept Vercel-style `"anthropic/claude-opus-4-7"` strings as the canonical form. |
| 3 | **Zod-schema-driven structured output** | Vercel AI SDK `Output.object()` | j-rig's `JudgeProvider.judge()` could return Zod-validated structured verdicts (currently `{verdict, confidence, reasoning}` is a free-form object). Vercel pattern would enforce the shape at the SDK layer. |
| 4 | **Per-vendor benchmark report (pass@N + edit-correct % + cost + malformed %)** | Aider polyglot leaderboard | New `packages/core/src/governance/per-vendor-scoring.ts` — for each `models` entry in the eval spec, emit a sub-report with the Aider column set + j-rig's blocker/regression columns. |
| 5 | **OTel `gen_ai.*` span emission per provider call** | OpenLLMetry | New `packages/core/src/telemetry/` directory; wrap every `TriggerProvider.selectSkill()` / `ExecutionProvider.execute()` / `JudgeProvider.judge()` call in OTel spans following the official `gen_ai.*` semantic conventions. Optional, opt-in via env var (mirrors Anthropic's `CLAUDE_CODE_ENABLE_TELEMETRY=1` pattern). |
| 6 | **Role-based model assignment in `EvalSpec`** | Continue.dev `config.yaml` roles | Already half-baked in j-rig: `TriggerProvider` vs `ExecutionProvider` vs `JudgeProvider` ARE role-based. Just expose the role assignment in `EvalSpec.models` — `models: [{vendor: anthropic, model: opus, roles: [trigger, judge]}, {vendor: openai, model: gpt-5, roles: [execution]}]`. |
| 7 | **`SpecAuthority` per-vendor extension** | j-rig's existing pattern in `packages/core/src/governance/spec-sources.ts` | Add `openaiSnapshotId`, `geminiSnapshotId`, `cursorSnapshotId`, `windsurfSnapshotId`, `mcpSnapshotId` to `SpecAuthority`. One quarterly-refreshed snapshot per vendor. Existing pattern; trivial extension. |
| 8 | **Vendor-namespaced check IDs** | j-rig's existing `anthropic:` prefix | Replace `anthropic:` with `vendor:<vendor>:` (e.g., `vendor:anthropic:name-no-xml`, `vendor:openai:agents-md-present`, `vendor:cursor:mdc-frontmatter-valid`). Backward-compat alias `anthropic:` → `vendor:anthropic:` for one minor release. |
| 9 | **AGENTS.md as the cross-vendor baseline parser** | agents.md open standard | New `packages/core/src/parsers/agents-md-parser.ts` — pure-MD heading-aware parser (Setup, Test, Build, Style sections), feeds vendors that recognize AGENTS.md. **This is the cheapest single shippable Phase B win** because ~20 vendors recognize it. |
| 10 | **`Skill(name)` permission-rule parser (cross-tool)** | Anthropic permission syntax | Generalizable to `Skill(<vendor>:<name>)` and `Tool(<vendor>:<name>)` — useful for vendor-neutral allowlist enforcement in `audit-harness` (sibling repo). |

---

## 8. Phase B scope recommendation

Eight concrete work items, ordered by ROI. Each carries: rationale, primary-source links, estimated effort, file paths. **No code is being written here** — these are the next-decision gates.

### 8.1 Vendor-namespace the schema

- **What**: Convert `ModelTarget` enum to a vendor-aware shape.
- **Files**: `packages/core/src/schemas/eval-spec.ts` (52 lines today), `packages/core/src/schemas/skill-frontmatter.ts` (93 lines today)
- **Schema shape** (proposed):
  ```typescript
  export const VendorEnum = z.enum([
    "anthropic", "openai", "google", "cursor", "windsurf",
    "continue", "aider", "cline", "agentskills", "mcp"
  ]);
  export const ModelTarget = z.object({
    vendor: VendorEnum,
    model: z.string(),
    roles: z.array(z.enum(["trigger", "execution", "judge"])).default(["trigger", "execution", "judge"]),
  });
  ```
- **Rationale**: Touches one schema file; unblocks every downstream provider extension. **Highest ROI per LOC changed.**
- **Effort**: ~1 day (schema + tests + ~5 callsite migrations).
- **Primary sources**: § 3.1 (Anthropic models), § 6 item 2 (Vercel factory).

### 8.2 Add provider adapters under `packages/cli/src/providers/`

- **What**: Spawn `openai.ts`, `gemini.ts`, `cursor.ts`, `windsurf.ts` mirroring the shape of `anthropic.ts` (82 lines, stub trio). Behind a single LiteLLM-backed implementation that picks vendor by `EvalSpec.models[].vendor`.
- **Files** (new):
  - `packages/cli/src/providers/litellm.ts` (single file, ~150 LOC, dispatches across all vendors)
  - OR `packages/cli/src/providers/{openai,gemini,cursor,windsurf,continue,aider,cline}.ts` (~80 LOC each, mirroring anthropic.ts)
- **Decision gate (do NOT pre-empt here)**: LiteLLM single-file vs Vercel-AI-SDK + N stubs. The Phase B research call should look at the type-safety / DX tradeoff in real code before committing.
- **Effort**: ~3 days for the LiteLLM-single-file path; ~6 days for the N-stub path.
- **Primary sources**: § 6 item 1 (LiteLLM), § 6 item 2 (Vercel AI SDK).

### 8.3 Rename `anthropic:` check IDs to `vendor:anthropic:`

- **What**: Find/replace across `packages/core/src/checks/package-checker.ts` (6 hits at lines 320, 327, 336, 343, 365, 378) plus update tests.
- **Files**: `packages/core/src/checks/package-checker.ts`, `packages/core/src/checks/package-checker.test.ts`
- **Compat**: Add deprecation alias map `{ "anthropic:name-no-xml": "vendor:anthropic:name-no-xml" }` for one minor release.
- **Effort**: ~½ day.
- **Primary sources**: § 7 item 8.

### 8.4 Add AGENTS.md parser

- **What**: Pure-Markdown parser with heading-aware sectioning (Setup / Test / Build / Style / Conventions / Tools / Limits). Vendor-neutral. Feeds all of OpenAI Codex / Gemini CLI / Aider / Copilot Coding Agent / etc.
- **Files** (new):
  - `packages/core/src/parsers/agents-md-parser.ts` (~120 LOC)
  - `packages/core/src/parsers/agents-md-parser.test.ts`
  - `references/specs/agents-md-spec.md` (new snapshot)
- **Rationale**: ~20 vendors recognize AGENTS.md per agents.md. Single parser covers the lowest-common-denominator surface across the whole ecosystem.
- **Effort**: ~1.5 days.
- **Primary sources**: § 4.2.

### 8.5 Add vendor-specific spec snapshots in `references/specs/`

- **What**: Six new snapshot files plus index update.
- **Files** (new):
  - `references/specs/openai-codex-spec.md`
  - `references/specs/gemini-cli-spec.md`
  - `references/specs/cursor-mdc-spec.md`
  - `references/specs/windsurf-rules-spec.md`
  - `references/specs/agents-md-spec.md`
  - `references/specs/mcp-spec.md`
- **Files (modify)**:
  - `packages/core/src/governance/spec-sources.ts` (192 lines today) — extend `SpecAuthority` with snapshot IDs + rule constants per vendor.
- **Rationale**: Existing pattern (Anthropic + AgentSkills.io) extends cleanly. PR-reviewed quarterly refresh is the human gate.
- **Effort**: ~2 days (writing + cross-referencing).
- **Primary sources**: all of § 3 + § 4.

### 8.6 Aider-style per-vendor reporting layer

- **What**: When an eval spec lists multiple vendor/model entries, emit a comparison table in the report output mirroring Aider's leaderboard (pass% per criterion, malformed-response count, cost, time-per-case).
- **Files** (new):
  - `packages/core/src/governance/per-vendor-scoring.ts` (~150 LOC)
- **Files (modify)**:
  - `packages/cli/src/commands/eval.ts` — emit the new table.
- **Effort**: ~2 days.
- **Primary sources**: § 3.8 + § 6 item 3.

### 8.7 OTel `gen_ai.*` span emission (opt-in)

- **What**: Wrap provider calls in OTel spans following the official `gen_ai.*` semantic conventions. Gated on `JRIG_ENABLE_TELEMETRY=1`.
- **Files** (new):
  - `packages/core/src/telemetry/instrumentation.ts` (~100 LOC)
- **Files (modify)**: Every `TriggerProvider`, `ExecutionProvider`, `JudgeProvider` implementation.
- **Rationale**: Pairs with the Kobiton R3 § 6 OTel framing. Lets eval runs be analyzed by any OTel collector (Honeycomb, Datadog, etc.).
- **Effort**: ~2 days.
- **Primary sources**: § 6 item 5 (OpenLLMetry).

### 8.8 MCP-conformance check bundle

- **What**: Deterministic checks that validate an MCP server config against the canonical MCP spec. Reusable across Claude Code / Cursor / Cline / Continue / Gemini CLI.
- **Files** (new):
  - `packages/core/src/checks/mcp-conformance.ts` (~200 LOC)
  - `references/specs/mcp-spec.md` (covered in 8.5)
- **Rationale**: MCP is normative across half the vendors. One check bundle = N-vendor coverage.
- **Effort**: ~2 days.
- **Primary sources**: § 4.3.

**Total effort estimate (one path):** ~14 days (single dev, sequential). Items can be parallelized — 8.1 and 8.5 must land first; 8.2-8.4, 8.6-8.8 parallelize cleanly after that.

---

## 9. What's NOT in scope for this document

Stated explicitly so readers don't draw conclusions this document doesn't support:

1. **Framework choice between LiteLLM and Vercel AI SDK.** Both are credible. The decision needs hands-on prototyping (item 8.2 above) — not a doc-level decree.
2. **Implementation code.** This is landscape mapping. The first PR should be 8.1 + 8.5 (schema + snapshots), at which point the abstraction shape is firmer and 8.2 can land with confidence.
3. **Vendor pitch / partnership argument.** This document does not argue that j-rig should ship as a Cursor-marketplace plugin, an OpenAI Codex add-on, etc. Those are sales / business-development decisions that come after the technical convergence lands.
4. **Pricing for cross-vendor evals.** Aider's leaderboard methodology includes per-run cost; j-rig adopting it (item 8.6) makes pricing observable but doesn't dictate a billing model.
5. **Spec-conformance audits of any specific vendor.** This document maps what's possible to audit; the actual audit work (e.g., the Kobiton R3 § 4 spec-conformance pass) is a separate engagement-shaped deliverable.
6. **Claude-API SDK migration in j-rig's stub providers.** `packages/cli/src/providers/anthropic.ts` is currently stub-only. Wiring it to the real `@anthropic-ai/sdk` is orthogonal to vendor-neutralization — both can ship in either order.
7. **Hugo-side docs / public website.** Methodology-track content under `intent-eval-lab/specs/` is the public face of this work; j-rig's own README is internal until convergence v0.1 ships.

---

## Appendix A — Primary sources cited (≥10 required, 14 cited)

1. https://code.claude.com/docs/en/skills (Anthropic Claude Code skills spec, § 3.1)
2. https://code.claude.com/docs/en/plugins (Anthropic plugins, § 3.1)
3. https://code.claude.com/docs/en/hooks (Anthropic hooks, § 3.1)
4. https://code.claude.com/docs/en/mcp (Anthropic MCP, § 3.1)
5. https://github.com/openai/codex (OpenAI Codex CLI, § 3.2)
6. https://github.com/google-gemini/gemini-cli (Gemini CLI, § 3.3)
7. https://cursor.com/docs (Cursor docs, § 3.4)
8. https://docs.windsurf.com/windsurf/cascade/memories (Windsurf rules/memories, § 3.5)
9. https://github.com/github/gh-copilot (Copilot CLI legacy, § 3.6)
10. https://github.com/continuedev/continue (Continue.dev, § 3.7)
11. https://github.com/Aider-AI/aider + https://aider.chat/docs/leaderboards/ (Aider, § 3.8)
12. https://github.com/cline/cline (Cline, § 3.9)
13. https://agentskills.io/specification (AgentSkills.io open standard, § 4.1)
14. https://agents.md/ (AGENTS.md open standard, § 4.2)
15. https://modelcontextprotocol.io/specification (MCP spec, § 4.3)
16. https://github.com/BerriAI/litellm (LiteLLM, § 6.1)
17. https://github.com/vercel/ai (Vercel AI SDK, § 6.2)
18. https://github.com/traceloop/openllmetry (OpenLLMetry, § 6.5)

## Appendix B — Empirical anchors from j-rig codebase

All file paths verified to exist 2026-05-10. Line counts captured via `wc -l`.

| Path | LOC | What |
|---|---|---|
| `packages/core/src/schemas/eval-spec.ts` | 52 | `ModelTarget` enum + `EvalSpec` schema |
| `packages/core/src/schemas/skill-frontmatter.ts` | 93 | `SkillModel` enum + `SkillFrontmatterSchema` |
| `packages/core/src/schemas/criterion.ts` | 45 | `CriterionSchema` (vendor-neutral) |
| `packages/core/src/governance/spec-sources.ts` | 192 | `SpecAuthority` snapshot loader |
| `packages/core/src/checks/package-checker.ts` | 396 | 6 × `anthropic:` check IDs |
| `packages/cli/src/providers/anthropic.ts` | 82 | Stub provider trio |
| `references/specs/anthropic-skills-spec.md` | (full) | Anthropic snapshot |
| `references/specs/agentskills-spec.md` | (full) | AgentSkills.io snapshot |

## Appendix C — Three-repo convergence anchors

This document is one of three workstreams in the Part 2 research plan; cross-references are kept inline to prevent drift.

- **Master plan**: `/home/jeremy/.claude/plans/please-take-your-time-glimmering-stardust.md` § Part 2.
- **Repo neighbors**:
  - `intent-eval-platform/intent-eval-lab/specs/mcp-plugin-observability/v0.1.0-draft/` — methodology source of truth.
  - `intent-eval-platform/audit-harness/` — deterministic enforcement (separate from j-rig's binary-criteria layer).
  - `intent-eval-platform/j-rig-binary-eval/` — this repo.

---

*— Jeremy Longshore*
*intentsolutions.io*
