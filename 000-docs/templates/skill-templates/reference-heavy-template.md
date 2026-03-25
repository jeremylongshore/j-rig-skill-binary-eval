---
name: {{SKILL_NAME}}
description: |
  {{PURPOSE}}. Use when {{TRIGGER_SCENARIOS}}.
  Trigger with "/{{SKILL_NAME}}" or "{{NATURAL_TRIGGER}}".
allowed-tools: "Read,Write,Edit,Glob,Grep,Bash({{TOOL_SCOPE}}:*)"
version: 1.0.0
author: {{AUTHOR_NAME}} <{{AUTHOR_EMAIL}}>
license: MIT
model: inherit
---

# {{SKILL_TITLE}}

## Overview

{{BRIEF_DESCRIPTION}}

## Quick Reference

| Task | Guide |
|------|-------|
| {{TASK_1}} | Read [{{REF_1}}](references/{{REF_1}}.md) |
| {{TASK_2}} | Read [{{REF_2}}](references/{{REF_2}}.md) |
| {{TASK_3}} | Read [{{REF_3}}](references/{{REF_3}}.md) |

## Instructions

### Step 1: Detect Variant

Determine which reference applies:
- If {{CONDITION_1}} → read `references/{{REF_1}}.md`
- If {{CONDITION_2}} → read `references/{{REF_2}}.md`
- If {{CONDITION_3}} → read `references/{{REF_3}}.md`

### Step 2: Follow Reference Guide

Each reference file contains the full workflow for that variant. Read only the relevant one — Claude reads on demand, not all at once.

### Step 3: Verify Output

{{VERIFICATION_STEPS}}

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| {{ERROR_1}} | {{CAUSE_1}} | {{SOLUTION_1}} |

## Resources

- `references/{{REF_1}}.md` — {{REF_1_PURPOSE}}
- `references/{{REF_2}}.md` — {{REF_2_PURPOSE}}
- `references/{{REF_3}}.md` — {{REF_3_PURPOSE}}
- `scripts/{{SCRIPT_1}}.py` — {{SCRIPT_1_PURPOSE}}

<!-- Source pattern: https://github.com/anthropics/skills/blob/main/skills/claude-api/SKILL.md -->
<!-- Also: https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md -->
<!-- Anthropic uses this pattern for skills with multiple domains/frameworks. -->
<!-- The SKILL.md acts as a router, each reference/ file handles one variant. -->
<!-- From Anthropic's skill-creator: "When a skill supports multiple domains/ -->
<!-- frameworks, organize by variant... Claude reads only the relevant file." -->
