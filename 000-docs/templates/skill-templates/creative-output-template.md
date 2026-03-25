---
name: {{SKILL_NAME}}
description: |
  {{CREATIVE_PURPOSE}}. Use when users request {{TRIGGER_SCENARIOS}}.
  Create original work rather than copying existing styles to avoid copyright violations.
allowed-tools: "Read,Write,Bash({{TOOL_SCOPE}}:*)"
version: 1.0.0
author: {{AUTHOR_NAME}} <{{AUTHOR_EMAIL}}>
license: MIT
model: inherit
---

# {{SKILL_TITLE}}

## Design Thinking

Before generating, understand the context and commit to a bold aesthetic direction:
- **Purpose**: What problem does this solve? Who is the audience?
- **Tone**: Pick a clear direction (minimal, maximalist, retro, organic, refined, playful, editorial, industrial, etc.)
- **Constraints**: Technical requirements (format, size, performance)
- **Differentiation**: What makes this unforgettable?

**Critical**: Choose a clear conceptual direction and execute with precision. Bold maximalism and refined minimalism both work — the key is intentionality, not intensity.

## Instructions

This happens in two steps:

### Step 1: Philosophy Creation

Create a {{CREATIVE_PHILOSOPHY}} that will be interpreted through:
- {{MEDIUM_1}}
- {{MEDIUM_2}}
- {{MEDIUM_3}}

Output a `.md` file describing the philosophy.

### Step 2: Express by Creating

Based on the philosophy, generate the final artifact:
- {{OUTPUT_FORMAT_1}}
- {{OUTPUT_FORMAT_2}}

## Output

{{OUTPUT_FILE_TYPES_AND_LOCATIONS}}

<!-- Source pattern: https://github.com/anthropics/skills/blob/main/skills/algorithmic-art/SKILL.md -->
<!-- Also: https://github.com/anthropics/skills/blob/main/skills/canvas-design/SKILL.md -->
<!-- Also: https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md -->
<!-- Anthropic uses this two-phase (philosophy → expression) pattern for creative skills -->
