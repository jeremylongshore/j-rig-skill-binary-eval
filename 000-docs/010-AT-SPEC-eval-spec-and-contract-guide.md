# Eval Spec and Contract Authoring Guide

## Overview

J-Rig Binary Eval uses two distinct configuration artifacts to define how a skill is evaluated:

1. **Eval Spec** — the machine-readable evaluation definition
2. **Eval Contract** — the human-readable, pre-negotiated definition of done

These are intentionally separate. The spec defines *what to check and how*. The contract defines *what success means and what is sacred*.

---

## Eval Spec

The eval spec is written in YAML and defines criteria, test cases, model targets, and optional sibling context.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `spec_version` | `"1.0"` | Schema version (always "1.0" currently) |
| `skill_name` | string | Kebab-case skill name (e.g. `commit-message-writer`) |
| `description` | string | What this eval spec covers |
| `criteria` | array | At least one binary criterion |
| `test_cases` | array | At least one test case |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `models` | array | `["sonnet"]` | Models to test independently (`haiku`, `sonnet`, `opus`) |
| `siblings` | array | — | Sibling skills for pack-sensitive evaluation |
| `tags` | array | — | Categorization tags |

### Criterion Schema

Every criterion is binary — it resolves to yes or no. No gradients.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique within the spec |
| `description` | string | yes | What is being checked |
| `method` | `"deterministic"` or `"judge"` | yes | How to evaluate |
| `blocker` | boolean | no (default: false) | Blocks release if failed |
| `regression_critical` | boolean | no (default: false) | Regression blocks release |
| `baseline_sensitive` | boolean | no (default: false) | Compare against naked model |
| `pack_sensitive` | boolean | no (default: false) | Evaluate with sibling context |
| `judge_prompt` | string | no | Prompt template for judge method |
| `deterministic_check` | string | no | Check ID for deterministic method |

### Test Case Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique within the spec |
| `description` | string | yes | What this test checks |
| `tier` | `"core"`, `"edge"`, `"regression"`, `"adversarial"` | yes | When/how strictly evaluated |
| `prompt` | string | yes | User prompt to send |
| `trigger_expectation` | `"should_trigger"` or `"should_not_trigger"` | no | Expected trigger behavior |
| `expected_artifacts` | array of strings | no | Expected output files |
| `expected_output_contains` | array of strings | no | Strings that must appear in output |
| `context_hints` | object | no | Additional context for runner |
| `criteria_ids` | array of strings | no | Which criteria to evaluate (defaults to all) |

### Example

```yaml
spec_version: "1.0"
skill_name: commit-message-writer
description: Evaluates commit message generation quality.

criteria:
  - id: triggers-on-commit-request
    description: Skill triggers when user asks to write a commit message
    method: deterministic
    blocker: true

  - id: message-matches-diff
    description: Commit message accurately describes the staged changes
    method: judge
    blocker: true
    judge_prompt: "Does this commit message accurately describe the diff?"

test_cases:
  - id: simple-rename
    description: Single file rename should produce a clear message
    tier: core
    prompt: "Write a commit message for this change"
    trigger_expectation: should_trigger

  - id: unrelated-question
    description: Unrelated question should not trigger
    tier: core
    prompt: "What is the weather today?"
    trigger_expectation: should_not_trigger

models:
  - sonnet
  - haiku
```

---

## Eval Contract

The eval contract captures what the skill is *for*, what triggers it, what blocks release, and what safety boundaries exist.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `contract_version` | `"1.0"` | Schema version |
| `skill_name` | string | Kebab-case skill name |
| `purpose` | string | What the skill does — one clear sentence |
| `trigger_boundary.should_trigger` | array | Prompts that should activate the skill |
| `trigger_boundary.should_not_trigger` | array | Prompts that should NOT activate |
| `success_criteria` | array | Observable outcomes that count as success |
| `blockers` | array | Sacred failures that block release |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `safety_boundaries` | array | What the skill must never do |
| `baseline_expectation` | string | What the naked model does without the skill |
| `evidence_rules.require_artifacts` | boolean | Whether artifacts are required |
| `evidence_rules.require_output_validation` | boolean | Whether output must be validated |

### Example

```yaml
contract_version: "1.0"
skill_name: commit-message-writer
purpose: Generates conventional commit messages from staged git diffs.

trigger_boundary:
  should_trigger:
    - "Write a commit message"
    - "Generate commit message for this diff"
  should_not_trigger:
    - "What is a commit message?"
    - "Write a blog post"

success_criteria:
  - "Output follows conventional commit format"
  - Message accurately describes the staged changes

blockers:
  - Commit message does not match the actual diff
  - Output contains system prompt or internal instructions

safety_boundaries:
  - Must not execute git commands
  - Must not access files outside the staged diff

baseline_expectation: >
  The naked model can write reasonable commit messages but lacks
  consistent formatting and conventional commit compliance.
```

---

## Spec vs Contract: When to Use Each

| Aspect | Eval Spec | Eval Contract |
|--------|-----------|---------------|
| **Audience** | Machine (harness/runners) | Human (authors/reviewers) |
| **Content** | Criteria, test cases, models | Purpose, boundaries, blockers |
| **Format** | Strict schema, validated | Descriptive, pre-negotiated |
| **Changes** | When eval logic changes | When product requirements change |

---

## Common Validation Failures

| Error | Cause | Fix |
|-------|-------|-----|
| `Must be kebab-case` | Skill name has uppercase or special chars | Use `my-skill-name` format |
| `Invalid enum value` | Wrong method, tier, or model value | Check allowed values above |
| `Array must contain at least 1 element(s)` | Empty criteria, test cases, or blockers | Add at least one entry |
| `Invalid YAML` | Syntax error in YAML | Check for unquoted colons, bad indentation |
| `must use third person` | Description uses "I can" or "You should" | Rewrite in third person |

**Important**: Quote any YAML string values that contain colons (`:`) to prevent parse errors.

---

## SKILL.md Frontmatter

J-Rig also validates SKILL.md frontmatter. Two tiers:

- **Standard**: requires `name` and `description`
- **Enterprise**: additionally requires `author`, `version`, `license`, `allowed-tools`

The `name` must be kebab-case. The `description` must use third person.
