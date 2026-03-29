# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**j-rig-binary-eval** — Seven-layer binary evaluation harness and rollout gate for Claude Skills (`SKILL.md` artifacts). Scores every skill change across package integrity, trigger quality, functional quality, regression protection, baseline value, model variance, and rollout safety — all binary yes/no criteria with external evaluators.

- **Runtime**: TypeScript, Node.js 20+, pnpm
- **Repo**: https://github.com/jeremylongshore/j-rig-binary-eval
- **License**: MIT
- **Current version**: stored in `version.txt`

## Build & Test

pnpm monorepo with four workspace packages (`@j-rig/core`, `@j-rig/cli`, `@j-rig/db`, `@j-rig/dashboard`). CI runs lint, typecheck, and tests on Node 22.

```bash
pnpm install                  # Install all workspace dependencies
pnpm run build                # Build all packages (tsup)
pnpm run test                 # Run vitest
pnpm run lint                 # ESLint (flat config, typescript-eslint)
pnpm run format:check         # Prettier check
pnpm run typecheck            # tsc --noEmit across all packages + tests/
pnpm run check                # Full validation (lint + typecheck + test)

# Single-package operations
pnpm --filter @j-rig/core run build
pnpm --filter @j-rig/cli run typecheck
```

## Architecture

Seven-layer evaluation stack (bottom to top):

1. **Spec Layer** — Human-authored YAML eval contracts, criteria definitions, test cases
2. **Execution Layer** — Runs skills against trigger/functional/regression/adversarial/baseline cases
3. **Observation Layer** — Captures outputs, artifacts, cost, latency, timing
4. **Judgment Layer** — Deterministic checks first, external LLM judges second
5. **Optimization Layer** — Failure clustering, weakest-criterion targeting, single atomic changes
6. **Evidence Layer** — SQLite persistence for runs, scores, regressions, baselines, launch reports
7. **CLI/CI/API** — Local author workflows, PR gating, team reporting

Key entities: `eval_specs`, `criteria`, `test_cases`, `runs`, `skill_versions`, `observed_outcomes`, `criterion_results`, `experiments`, `regressions`, `baselines`, `launch_reports`

Planned stack: commander, @clack/prompts, zod, @anthropic-ai/sdk, better-sqlite3, drizzle-orm, p-limit

## Non-Negotiable Design Principles

1. **Criteria must be binary** — yes or no, no gradients or fuzzy scores
2. **Evaluator is always separate** — the skill under test never judges itself
3. **Observed behavior outranks claimed behavior** — grade what happened, not what the skill says
4. **Regression tests are sacred** — a regression on a sacred case blocks release regardless of average improvement
5. **One change at a time** — optimizer proposes exactly one atomic change per experiment
6. **Blockers block release** — a blocker failure cannot be averaged out
7. **Baseline value matters** — if the naked model matches the skill, flag for obsolete review
8. **Model-aware testing** — Haiku/Sonnet/Opus tested independently

## Epic Roadmap

10 sequential epics. Master blueprint: `000-docs/007-PP-PLAN-master-build-blueprint.md`. Epic details: `000-docs/epics/`.

| # | Epic | Scope |
|---|------|-------|
| 01 | Repo Foundation | Workspace skeleton, governance, CI |
| 02 | Spec Layer | YAML eval contracts, criteria schema, test case format |
| 03 | Package Integrity | Deterministic structure/metadata validation |
| 04 | Evidence Layer | SQLite persistence, run lifecycle |
| 05 | Trigger Harness | Roster builder, trigger simulation, precision/recall |
| 06 | Functional Execution | Skill invocation, context injection, artifact capture |
| 07 | Judgment Layer | Binary judge engine, calibration, per-model matrix |
| 08 | Regression/CLI/CI | Regression comparison, baseline gating, CLI, PR gate |
| 09 | Optimizer | Failure clustering, one-change proposals, experiment runner |
| 10 | Team Product | Dashboard, eval packs, drift reevaluation |

## Reference Library

`000-docs/` contains 32+ reference files organized by purpose:

- `templates/skill-templates/` — 6 SKILL.md structural patterns
- `templates/eval-schemas/` — Eval JSON schemas
- `references/skill-standards/` — AgentSkills.io spec, validation rules
- `references/eval-patterns/` — Eval methodology, workflows
- `references/agents/` — Grader, comparator, analyzer agent patterns
- `references/enterprise-standards/` — 100-point rubric, validator schema registry
- `references/drift-and-consistency/` — Drift categories, source-of-truth hierarchy
- `references/epic-workflows/` — ASCII workflow diagrams (one per epic)

## Conventions

- Commit messages: `<type>(<scope>): <subject>` (conventional commits)
- Branch naming: `feature/`, `fix/`, `docs/`
- Doc filing: `000-docs/` with v4 naming convention (`NNN-CC-CODE-description.md`)
- Releases: automated via `.github/workflows/release.yml` (auto-bumps version from commit messages)

## Task Tracking with Beads (bd)

**Beads provides post-compaction recovery.** Run `/beads` at session start.

**Workflow:** `bd update <id> --status in_progress` → work → `bd close <id> --reason "evidence"` → `bd sync`

Key commands: `bd prime` (LLM context), `bd ready`, `bd list --status in_progress`, `bd doctor`
