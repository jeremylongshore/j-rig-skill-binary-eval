<!-- PROVENANCE: Extracted from ~/000-projects/claude-code-plugins/scripts/validate-skills-schema.py
     (v5.0, lines 113-210) on 2026-03-24. Schema registry synced 2026-03-21.
     This is Tier 0 authority for field-level validation. -->

# Validate-Skills-Schema Registry v5.0

Source: `validate-skills-schema.py` — Single Source of Truth for field schemas.

## Skill Fields (11 Anthropic + 5 Enterprise = 16 total)

### Anthropic Official (11 fields)

| Field | Type | Valid Values | Notes |
|-------|------|-------------|-------|
| `name` | string | — | Required (standard + enterprise) |
| `description` | string | — | Required (standard + enterprise) |
| `allowed-tools` | string | — | Space-delimited tool list |
| `model` | string | `sonnet`, `haiku`, `opus`, `inherit` | LLM model override |
| `effort` | string | `low`, `medium`, `high`, `max` | Reasoning effort |
| `argument-hint` | string | — | Autocomplete hint |
| `context` | string | `fork` | Run in subagent |
| `agent` | string | — | Subagent type |
| `user-invocable` | boolean | — | Default: true |
| `disable-model-invocation` | boolean | — | Default: false |
| `hooks` | object | — | Lifecycle hooks |

### Enterprise Additions (5 fields)

| Field | Type | Notes |
|-------|------|-------|
| `version` | string | SemVer |
| `author` | string | Name + email |
| `license` | string | License identifier |
| `compatible-with` | string | Platform compatibility |
| `tags` | array | Discovery tags |

### Enterprise ALWAYS_REQUIRED

```
name, description, allowed-tools, version, author, license, compatible-with, tags
```

### Conditional Fields

| Field | Required When |
|-------|--------------|
| `context` | Agent field is set |
| `agent` | Context is 'fork' |
| `argument-hint` | User-invocable AND not disable-model-invocation |

### Facelift Opportunities (optional improvements)

| Field | Rationale |
|-------|-----------|
| `model` | Prevents unexpected behavior when session model changes |
| `effort` | Optimizes reasoning for skill's complexity |

## Agent Fields (12 Anthropic)

| Field | Type | Required | Valid Values |
|-------|------|----------|-------------|
| `name` | string | **Yes** | — |
| `description` | string | **Yes** | — |
| `model` | string | No | `sonnet`, `haiku`, `opus`, `inherit` |
| `effort` | string | No | `low`, `medium`, `high`, `max` |
| `maxTurns` | integer | No | — |
| `tools` | string | No | — |
| `disallowedTools` | array | No | — |
| `skills` | array | No | — |
| `mcpServers` | object | No | — |
| `hooks` | object | No | — |
| `memory` | string | No | `user`, `project`, `local` |
| `background` | boolean | No | — |
| `isolation` | string | No | `worktree` |
| `permissionMode` | string | No | `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan` |

### Agent Plugin-Restricted Fields

These fields are silently ignored by the runtime in plugin agents:
```
hooks, mcpServers, permissionMode
```

## Invalid Skill Fields (ERROR)

| Field | Reason |
|-------|--------|
| `compatibility` | AgentSkills.io field, not Anthropic. Remove. |
| `metadata` | AgentSkills.io field, not Anthropic. Use top-level fields. |
| `when_to_use` | Deprecated. Move content to description field. |
| `mode` | Deprecated. Use `disable-model-invocation` instead. |

## Deprecated Agent Fields (WARN)

| Field | Status |
|-------|--------|
| `capabilities` | Non-standard. Not in Anthropic spec. Will be removed. |
| `expertise_level` | Non-standard. Not in Anthropic spec. Will be removed. |
| `activation_priority` | Non-standard. Not in Anthropic spec. Will be removed. |
| `color` | Non-standard. Not in Anthropic spec. Will be removed. |
| `activation_triggers` | Non-standard. Not in Anthropic spec. Will be removed. |
| `type` | Non-standard. Not in Anthropic spec. Will be removed. |
| `category` | Non-standard. Not in Anthropic spec. Will be removed. |

## Plugin.json Fields

| Field | Type | Required |
|-------|------|----------|
| `name` | string | **Yes** |
| `version` | string | No |
| `description` | string | No |
| `author` | object | No |
| `homepage` | string | No |
| `repository` | string | No |
| `license` | string | No |
| `keywords` | array | No |
| `commands` | string\|array | No |
| `agents` | string\|array | No |
| `skills` | string\|array | No |
| `hooks` | string\|array\|object | No |
| `mcpServers` | string\|array\|object | No |
| `outputStyles` | string\|array | No |
| `lspServers` | string\|array\|object | No |

## Valid Tool Names

```
Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch,
Task, TodoWrite, NotebookEdit, AskUserQuestion, Skill
```
