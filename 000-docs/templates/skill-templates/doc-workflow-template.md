---
name: {{SKILL_NAME}}
description: |
  Guide users through a structured workflow for {{WORKFLOW_PURPOSE}}.
  Use when user wants to {{TRIGGER_SCENARIOS}}.
  Trigger with "/{{SKILL_NAME}}" or "{{NATURAL_TRIGGER}}".
allowed-tools: "Read,Write,Edit,Glob,Grep,AskUserQuestion"
version: 1.0.0
author: {{AUTHOR_NAME}} <{{AUTHOR_EMAIL}}>
license: MIT
model: inherit
---

# {{SKILL_TITLE}}

Structured workflow for {{PURPOSE}}. Three stages: Context Gathering, Refinement, and Verification.

## When to Offer This Workflow

**Trigger conditions:**
- {{TRIGGER_1}}
- {{TRIGGER_2}}
- {{TRIGGER_3}}

## Instructions

### Stage 1: Context Gathering

Use AskUserQuestion to gather:
1. {{CONTEXT_QUESTION_1}}
2. {{CONTEXT_QUESTION_2}}
3. {{CONTEXT_QUESTION_3}}

Ask clarifying questions about edge cases, format preferences, and success criteria. Wait to draft until context is solid.

### Stage 2: Draft and Refine

1. Generate initial draft based on gathered context
2. Present to user for feedback
3. Iterate based on feedback (max 3 rounds)

### Stage 3: Verify

1. {{VERIFICATION_STEP_1}}
2. {{VERIFICATION_STEP_2}}
3. Present final output

## Output

{{OUTPUT_FORMAT_DESCRIPTION}}

## Examples

### {{EXAMPLE_SCENARIO}}

**User says**: "{{EXAMPLE_PROMPT}}"

**Result**: {{EXAMPLE_OUTPUT_DESCRIPTION}}

<!-- Source pattern: https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md -->
<!-- Also: https://github.com/anthropics/skills/blob/main/skills/internal-comms/SKILL.md -->
<!-- Anthropic uses this interactive wizard pattern for content creation skills -->
