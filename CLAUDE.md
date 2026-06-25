# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**j-rig-binary-eval** — Seven-layer binary evaluation harness and rollout gate for Claude Skills (`SKILL.md` artifacts). Scores every skill change across package integrity, trigger quality, functional quality, regression protection, baseline value, model variance, and rollout safety — all binary yes/no criteria with external evaluators.

- **Runtime**: TypeScript, Node.js 20+, pnpm
- **Repo**: <https://github.com/jeremylongshore/j-rig-binary-eval>
- **License**: Apache-2.0 (relicensed from MIT in v1.0.0; `0.x` artifacts remain available under their original MIT terms)
- **Current version**: stored in `version.txt`

## Build & Test

pnpm monorepo with nine workspace packages. **Only the three `@intentsolutions/*` packages are published to npm.** Two `@j-rig/*` utilities are `private: false` (publishable) but are **not on npm** — the `@j-rig` scope is unpublished (publishing there 403s; the npm key owns `@intentsolutions`). The four internal eval-engine packages are `private: true`. CI runs lint, typecheck, and tests on Node 22.

| Package | Scope | Published? | Role |
| --- | --- | --- | --- |
| `@intentsolutions/refiner-core` | `@intentsolutions` | yes | Skill Refiner pure core: bounded-edit apply, synthetic eval-set bootstrap, Pareto-dominant acceptance gate, `RefinerStrategy` interface |
| `@intentsolutions/refiner` | `@intentsolutions` | yes | Skill Refiner orchestrator + I/O adapters + `j-rig refine` CLI; wraps `@intentsolutions/refiner-core` |
| `@intentsolutions/rollout-gate` | `@intentsolutions` | yes | Thin rollout decision-logic library: consume a `gate-result/v1` Evidence Bundle + policy → allow/block (fail closed) |
| `@j-rig/migrate` | `@j-rig` | no (not on npm) | Codemod rewriting `v0.1.0-draft` Evidence Bundle rows into the v2.0 `gate-result/v1` shape |
| `@j-rig/pr-comment` | `@j-rig` | no (not on npm) | Pure idempotent renderer: rollout-gate decision → marker-anchored markdown PR comment block |
| `@j-rig/core` | `@j-rig` | no (internal) | Core eval-engine types + logic |
| `@j-rig/cli` | `@j-rig` | no (internal) | Local author / CI CLI |
| `@j-rig/db` | `@j-rig` | no (internal) | SQLite evidence persistence |
| `@j-rig/dashboard` | `@j-rig` | no (internal) | Team dashboard (Epic 10 — placeholder) |

Single-package commands still use the workspace name, e.g. `pnpm --filter @j-rig/core run build`.

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

Implementation stack: commander, chalk, zod, better-sqlite3, drizzle-orm. The Anthropic provider speaks the Messages API wire format directly through an injectable `Transport` seam rather than the `@anthropic-ai/sdk` (no added SDK dependency).

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

| #   | Epic                 | Scope                                                       |
| --- | -------------------- | ----------------------------------------------------------- |
| 01  | Repo Foundation      | Workspace skeleton, governance, CI                          |
| 02  | Spec Layer           | YAML eval contracts, criteria schema, test case format      |
| 03  | Package Integrity    | Deterministic structure/metadata validation                 |
| 04  | Evidence Layer       | SQLite persistence, run lifecycle                           |
| 05  | Trigger Harness      | Roster builder, trigger simulation, precision/recall        |
| 06  | Functional Execution | Skill invocation, context injection, artifact capture       |
| 07  | Judgment Layer       | Binary judge engine, calibration, per-model matrix          |
| 08  | Regression/CLI/CI    | Regression comparison, baseline gating, CLI, PR gate        |
| 09  | Optimizer            | Failure clustering, one-change proposals, experiment runner |
| 10  | Team Product         | Dashboard, eval packs, drift reevaluation                   |

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

## AI code review (Greptile + Gemini)

Two AI reviewers run on PRs here, **both advisory** — neither is a branch-protection
required check. The deterministic merge gate is this repo's own CI (`pnpm run check` (lint + typecheck + test)) plus CodeQL.

- **Gemini Code Assist** (`.gemini/config.yaml` + `.gemini/styleguide.md`) is the
  **active** reviewer. Re-instated 2026-06-24 as the fallback after the Greptile
  review quota was exhausted. Workhorse for design / logic / correctness /
  cross-artifact consistency; CodeQL owns security.
- **Greptile** (`.greptile/config.json` + `rules.md` + `files.json`) is configured to
  the platform-unified schema (`strictness: 3`, `commentTypes: ["logic","syntax"]`,
  `statusCheck: false`, a universal `no-gate-weakening` rule, plus this repo's scoped
  invariant rules). It stays in place and resumes when the Greptile quota resets.

Read either review when present; the required gate is CI. Re-installing/uninstalling
the GitHub Apps is an admin (UI) action — the in-repo config here does not install them.

## Task Tracking with Beads (bd)

**Beads provides post-compaction recovery.** Run `/beads` at session start.

**Workflow:** `bd update <id> --status in_progress` → work → `bd close <id> --reason "evidence"` → `bd sync`

Key commands: `bd prime` (LLM context), `bd ready`, `bd list --status in_progress`, `bd doctor`

## Testing baseline (2026-05-01 — Intent Solutions Testing SOP)

This repo participates in the **Intent Solutions Testing SOP** per `~/.claude/CLAUDE.md` § "Intent Solutions Testing SOP" and the VPS-as-the-home program (`OPS-5nm`, Priority 6).

**Installed**: `@intentsolutions/audit-harness v0.1.0` vendored at `.audit-harness/` with wrapper at `scripts/audit-harness`.

**Commands**: `scripts/audit-harness {verify, init, list, escape-scan --staged}`.

**Next step**: run `/audit-tests` to produce `TEST_AUDIT.md`. See `000-docs/010-TQ-SOPS-audit-harness-baseline-2026-05-01.md`.

**Upgrade**: `AUDIT_HARNESS_VERSION=vX.Y.Z curl -sSL https://raw.githubusercontent.com/jeremylongshore/audit-harness/main/install.sh | bash`. Or run `/sync-testing-harness` from any session.

> **Note**: this repo IS the seven-layer binary eval harness for Claude Skills. The audit-harness install adds a complementary 7-layer testing taxonomy gate at the repo level — independent of the skill-eval harness, applied to this repo's own code.
