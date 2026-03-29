---
name: commit-message-writer
description: Generates conventional commit messages from staged git diffs. Activates when the user requests a commit message and produces type(scope) subject format.
author: Jeremy Longshore <jeremy@jeremylongshore.com>
version: 1.0.0
license: MIT
allowed-tools: Bash(git:diff --staged)
tags:
  - git
  - developer-tools
model: sonnet
---

# Commit Message Writer

Generate a commit message for the currently staged changes.

## Instructions

1. Read the staged diff using `git diff --staged`
2. Analyze the changes to determine:
   - The type (feat, fix, docs, refactor, test, chore, ci, style)
   - The scope (affected module or component)
   - A concise subject line (under 72 characters)
3. Output the commit message in conventional commit format

## Format

```
type(scope): subject line

Optional body explaining the motivation for the change.
```

## Examples

Input: A diff showing a new function added to `auth.ts`
Output: `feat(auth): add token refresh endpoint`

Input: A diff fixing a typo in `README.md`
Output: `docs(readme): fix installation instructions typo`
