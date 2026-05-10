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

## Three-repo convergence (Phase A: 3 beads filed 2026-05-10)

This repo is the **7-layer judgment harness** in the three-repo convergence vision (`intent-eval-lab` + `audit-harness` + `j-rig-binary-eval`). The convergence sits on a shared **Evidence Bundle** schema authored upstream in `intent-eval-lab/specs/evidence-bundle/v0.1.0-draft/`. This repo will consume bundle rows (audit-harness emissions) and emit verdict rows back; the schema is the lingua franca, not a package consolidation.

**Master plan (local-only):** `~/.claude/plans/please-take-your-time-glimmering-stardust.md`
**ID mapping artifact:** `~/.claude/plans/please-take-your-time-glimmering-stardust-id-map.md`
**Convergence umbrella:** [`jeremylongshore/intent-eval-lab#4`](https://github.com/jeremylongshore/intent-eval-lab/issues/4) (`IEL-CONV-1`)

### Phase A landed (this repo)

3 beads filed as **additive scope** to existing epics (NOT new epics):

| Bead | Planning ID | GH | Plane | Folds into |
|---|---|---|---|---|
| `j-rig-binary-eval-mje` | `JR-EPIC-03a` | [`#42`](https://github.com/jeremylongshore/j-rig-binary-eval/issues/42) | JRIG-5 | Epic 03 (Package Integrity) — +1 day scope |
| `j-rig-binary-eval-mul` | `JR-EPIC-04a` | [`#43`](https://github.com/jeremylongshore/j-rig-binary-eval/issues/43) | JRIG-6 | Epic 04 (Evidence Layer) — +2 days scope |
| `j-rig-binary-eval-7js` | `JR-EPIC-06a-prep` | [`#44`](https://github.com/jeremylongshore/j-rig-binary-eval/issues/44) | JRIG-7 | Future Epic 06 — interface only, Phase C |

The bundle integration is **backward-compatible** — `eval-spec.yaml` stays the primary input; bundle is OPTIONAL.

### Phase B work (gated on first paying-customer signal)

- `JR-EPIC-03a` (folds into Epic 03) — `packages/core/src/validators/evidence-bundle.ts` (Zod schema for envelope)
- `JR-EPIC-04a` (folds into Epic 04) — `packages/db/src/adapters/evidence-bundle-{input,output}.ts` (parse rows → `criterion_results`; emit verdict rows back)
- `JR-EPIC-06a-prep` (Phase C, future Epic 06 interface only) — `packages/core/src/execution/evidence-bundle-context.ts`

**No new npm deps required** — Zod + yaml + `@anthropic-ai/sdk` already in stack.

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

## Testing baseline (2026-05-01 — Intent Solutions Testing SOP)

This repo participates in the **Intent Solutions Testing SOP** per `~/.claude/CLAUDE.md` § "Intent Solutions Testing SOP" and the VPS-as-the-home program (`OPS-5nm`, Priority 6).

**Installed**: `@intentsolutions/audit-harness v0.1.0` vendored at `.audit-harness/` with wrapper at `scripts/audit-harness`.

**Commands**: `scripts/audit-harness {verify, init, list, escape-scan --staged}`.

**Next step**: run `/audit-tests` to produce `TEST_AUDIT.md`. See `000-docs/010-TQ-SOPS-audit-harness-baseline-2026-05-01.md`.

**Upgrade**: `AUDIT_HARNESS_VERSION=vX.Y.Z curl -sSL https://raw.githubusercontent.com/jeremylongshore/audit-harness/main/install.sh | bash`. Or run `/sync-testing-harness` from any session.

> **Note**: this repo IS the seven-layer binary eval harness for Claude Skills. The audit-harness install adds a complementary 7-layer testing taxonomy gate at the repo level — independent of the skill-eval harness, applied to this repo's own code.
