<!-- PROVENANCE: Extracted from https://agentskills.io/specification on 2026-03-24.
     This is the Tier 0 authority — all other standards defer to this on hard limits. -->

# AgentSkills.io Official Specification

> The complete format specification for Agent Skills — extracted from the official source.

## Directory Structure

A skill is a directory containing, at minimum, a `SKILL.md` file:

```
skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── ...               # Any additional files or directories
```

## SKILL.md Format

The `SKILL.md` file must contain YAML frontmatter followed by Markdown content.

### Frontmatter Fields

| Field           | Required | Constraints |
|-----------------|----------|-------------|
| `name`          | **Yes**  | Max 64 characters. Lowercase letters, numbers, and hyphens only. Must not start or end with a hyphen. Must not contain consecutive hyphens. Must match parent directory name. |
| `description`   | **Yes**  | Max 1024 characters. Non-empty. Describes what the skill does and when to use it. |
| `license`       | No       | License name or reference to a bundled license file. |
| `compatibility` | No       | Max 500 characters if provided. Indicates environment requirements (intended product, system packages, network access, etc.). |
| `metadata`      | No       | Arbitrary key-value mapping (string keys → string values) for additional metadata. |
| `allowed-tools` | No       | **Space-delimited** list of pre-approved tools the skill may use. (Experimental) |

### Hard Limits Summary

| Constraint | Limit |
|-----------|-------|
| `name` length | 1–64 characters |
| `name` charset | `[a-z0-9-]`, no start/end hyphen, no consecutive hyphens |
| `name` must match | Parent directory name |
| `description` length | 1–1024 characters |
| `compatibility` length | 1–500 characters (if provided) |
| `SKILL.md` body | < 500 lines recommended |
| Instructions token budget | < 5,000 tokens recommended |
| Aggregate description budget | 15,000 characters across ALL loaded skill descriptions |
| `allowed-tools` syntax | Space-delimited (NOT comma-delimited) |
| File references | One level deep from SKILL.md |
| File reference paths | Relative paths only |

### `name` Field

- Must be 1–64 characters
- May only contain unicode lowercase alphanumeric characters (`a-z`) and hyphens (`-`)
- Must not start or end with a hyphen (`-`)
- Must not contain consecutive hyphens (`--`)
- Must match the parent directory name

**Valid:** `pdf-processing`, `data-analysis`, `code-review`
**Invalid:** `PDF-Processing` (uppercase), `-pdf` (starts with hyphen), `pdf--processing` (consecutive hyphens)

### `description` Field

- Must be 1–1024 characters
- Should describe both what the skill does AND when to use it
- Should include specific keywords that help agents identify relevant tasks

**Good:** "Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction."

**Poor:** "Helps with PDFs."

### `license` Field

- Specifies the license applied to the skill
- Keep short: either the license name or the name of a bundled license file

### `compatibility` Field

- Must be 1–500 characters if provided
- Only include if the skill has specific environment requirements
- Can indicate intended product, required system packages, network access needs

**Examples:** `Designed for Claude Code (or similar products)`, `Requires git, docker, jq, and access to the internet`, `Requires Python 3.14+ and uv`

Most skills do not need this field.

### `metadata` Field

- Map from string keys to string values
- Clients use this to store additional properties not defined by the spec
- Make key names reasonably unique to avoid accidental conflicts

### `allowed-tools` Field

- **Space-delimited** list of tools that are pre-approved to run
- Experimental — support may vary between agent implementations

**Example:** `Bash(git:*) Bash(jq:*) Read`

## Body Content

The Markdown body after frontmatter contains skill instructions. No format restrictions — write whatever helps agents perform the task effectively.

Recommended sections:
- Step-by-step instructions
- Examples of inputs and outputs
- Common edge cases

The agent loads the entire file once it decides to activate a skill. Consider splitting longer content into referenced files.

## Progressive Disclosure

Skills should be structured for efficient use of context:

| Layer | Budget | When Loaded |
|-------|--------|-------------|
| **Metadata** | ~100 tokens | At startup for ALL skills |
| **Instructions** | < 5,000 tokens recommended | When skill is activated |
| **Resources** | As needed | Only when required |

Keep `SKILL.md` under 500 lines. Move detailed reference material to separate files.

## File References

Use relative paths from the skill root:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
Run the extraction script: scripts/extract.py
```

Keep file references **one level deep** from `SKILL.md`. Avoid deeply nested reference chains.

## Optional Directories

### `scripts/`

Executable code that agents can run. Scripts should:
- Be self-contained or clearly document dependencies
- Include helpful error messages
- Handle edge cases gracefully

Supported languages depend on agent implementation (Python, Bash, JavaScript common).

### `references/`

Additional documentation loaded on demand:
- `REFERENCE.md` — Detailed technical reference
- `FORMS.md` — Form templates or structured data formats
- Domain-specific files (`finance.md`, `legal.md`, etc.)

Keep individual reference files focused — smaller files mean less context usage.

### `assets/`

Static resources: templates, images (diagrams, examples), data files (lookup tables, schemas).

## Validation

Use the [skills-ref](https://github.com/agentskills/agentskills/tree/main/skills-ref) reference library:

```bash
skills-ref validate ./my-skill
```

Checks `SKILL.md` frontmatter validity and naming conventions.

---

## Anthropic Runtime Extensions (Not in AgentSkills.io Spec)

These fields are supported by Claude Code but are NOT part of the AgentSkills.io specification:

| Field | Type | Notes |
|-------|------|-------|
| `model` | string | `sonnet`, `haiku`, `opus`, `inherit` |
| `effort` | string | `low`, `medium`, `high`, `max` |
| `argument-hint` | string | Autocomplete hint for user-invocable skills |
| `context` | string | `fork` — run in subagent |
| `agent` | string | Subagent type when context=fork |
| `user-invocable` | boolean | Show in / menu (default: true) |
| `disable-model-invocation` | boolean | Prevent model auto-activation (default: false) |
| `hooks` | object | Lifecycle hooks |

## Enterprise Extensions (Intent Solutions)

These fields extend the standard for marketplace/enterprise use:

| Field | Type | Enterprise Required |
|-------|------|-------------------|
| `version` | string | Yes |
| `author` | string | Yes |
| `license` | string | Yes |
| `compatible-with` | string | Yes |
| `tags` | array | Yes |

Enterprise `ALWAYS_REQUIRED` set: `name`, `description`, `allowed-tools`, `version`, `author`, `license`, `compatible-with`, `tags`

## Invalid Fields (ERROR in Enterprise Validation)

| Field | Reason |
|-------|--------|
| `compatibility` | AgentSkills.io field, not Anthropic. Remove. |
| `metadata` | AgentSkills.io field, not Anthropic. Use top-level fields. |
| `when_to_use` | Deprecated. Move content to description field. |
| `mode` | Deprecated. Use `disable-model-invocation` instead. |
