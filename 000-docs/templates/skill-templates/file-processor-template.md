---
name: {{SKILL_NAME}}
description: |
  Use this skill whenever the user wants to create, read, edit, or manipulate
  {{FILE_TYPE}} files. Triggers include: any mention of '{{FILE_EXTENSION}}',
  or requests to produce {{OUTPUT_DESCRIPTION}}. Also use when extracting or
  reorganizing content from {{FILE_TYPE}} files.
allowed-tools: "Read,Write,Edit,Glob,Grep,Bash(python:*)"
version: 1.0.0
author: {{AUTHOR_NAME}} <{{AUTHOR_EMAIL}}>
license: MIT
model: inherit
---

# {{FILE_TYPE}} Processing Guide

## Overview

{{BRIEF_DESCRIPTION_OF_FORMAT_AND_APPROACH}}

## Quick Reference

| Task | Approach |
|------|----------|
| Read/analyze content | {{READ_METHOD}} |
| Create new file | {{CREATE_METHOD}} |
| Edit existing file | {{EDIT_METHOD}} |

## Instructions

### Step 1: Detect Operation

Determine what the user needs:
- **Read/extract**: Parse existing {{FILE_EXTENSION}} and return content
- **Create**: Generate new {{FILE_EXTENSION}} from scratch
- **Edit**: Modify existing {{FILE_EXTENSION}} in place

### Step 2: Execute

{{DETAILED_INSTRUCTIONS_PER_OPERATION}}

## Output

Save output to the user's specified path. If no path given, use the current directory.

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| File not found | Invalid path | Verify path with Glob |
| Parse error | Corrupted file | Try alternate parser |
| Permission denied | Read-only location | Ask user for writable path |

<!-- Source pattern: https://github.com/anthropics/skills/blob/main/skills/docx/SKILL.md -->
<!-- Also: https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md -->
<!-- Also: https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md -->
<!-- Anthropic uses this pattern for docx, pdf, pptx, xlsx skills -->
