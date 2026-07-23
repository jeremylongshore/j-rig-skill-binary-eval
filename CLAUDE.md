# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**j-rig-binary-eval** — Seven-layer binary evaluation harness and rollout gate for Claude Skills (`SKILL.md` artifacts). Scores every skill change across package integrity, trigger quality, functional quality, regression protection, baseline value, model variance, and rollout safety — all binary yes/no criteria with external evaluators.

- **Runtime**: TypeScript, Node.js 20+, pnpm
- **Repo**: <https://github.com/jeremylongshore/j-rig-binary-eval>
- **License**: Apache-2.0 (relicensed from MIT in v1.0.0; `0.x` artifacts remain available under their original MIT terms)
- **Current version**: stored in `version.txt`

## Build & Test

pnpm monorepo with nine workspace packages. **Five `@intentsolutions/*` packages are published to npm** — the three Refiner/rollout libraries plus the **`@intentsolutions/jrig-cli`** eval CLI (the `j-rig` command). The CLI is the leaf binary: it BUNDLES the private `@j-rig/{core,db,migrate}` eval-engine packages into its published artifact so external repos can `npm install` a working CLI without resolving any unpublished `@j-rig/*` package (the `@j-rig` scope 403s on publish; the npm key owns `@intentsolutions`). The remaining `@j-rig/*` packages stay internal/unpublished. CI runs lint, format:check, typecheck, and tests on Node 22.

| Package | Scope | Published? | Role |
| --- | --- | --- | --- |
| `@intentsolutions/jrig-cli` | `@intentsolutions` | yes | The `j-rig` eval CLI — self-contained npm package (bundles `@j-rig/{core,db,migrate}`); external repos install it to run the eval harness in CI (5 of 7 layers by default; regression + baseline opt-in). Bin name stays `j-rig`. |
| `@intentsolutions/refiner-core` | `@intentsolutions` | yes | Skill Refiner pure core: bounded-edit apply, synthetic eval-set bootstrap, Pareto-dominant acceptance gate, `RefinerStrategy` interface, COMPUTED per-block slice-utility (LOBO causal attribution), and the DETERMINISTIC time-decay **adoption signal** (`adoption.ts` — 2×2 baseline-value × decayed-adoption, bandit rejected; epic intent-eval-lab#206 / ISEDC DR-103) |
| `@intentsolutions/refiner` | `@intentsolutions` | yes | Skill Refiner orchestrator + I/O adapters + `j-rig refine` CLI; wraps `@intentsolutions/refiner-core`. **Provider-agnostic** since 0.3.0: `refine score/propose --provider` resolves any backend (groq/deepseek/openai/anthropic/nvidia/kimi/openrouter) via a shared registry — Anthropic is never required |
| `@intentsolutions/rollout-gate` | `@intentsolutions` | yes | Thin rollout decision-logic library: consume a `gate-result/v1` Evidence Bundle + policy → allow/block (fail closed) |
| `@j-rig/migrate` | `@j-rig` | no (bundled into jrig-cli) | Codemod rewriting `v0.1.0-draft` Evidence Bundle rows into the v2.0 `gate-result/v1` shape |
| `@intentsolutions/pr-comment` | `@intentsolutions` | yes | Pure idempotent renderer with ZERO runtime deps: rollout-gate decision → marker-anchored markdown PR comment block. Renamed from `@j-rig/pr-comment` and published because doc 110 § 6 step 3 names it as a platform deliverable and it had 404'd on npm since it was written; the `@j-rig` scope 403s, so it took the same rename `rollout-gate` did |
| `@j-rig/core` | `@j-rig` | no (bundled into jrig-cli) | Core eval-engine types + logic |
| `@j-rig/db` | `@j-rig` | no (bundled into jrig-cli) | SQLite evidence persistence + the skill-signal intake fact tables (CASS-gated `skill_usage_events`, curated-signal `skill_human_reviews`; epic intent-eval-lab#206 / DR-103) |
| `@j-rig/dashboard` | `@j-rig` | no (internal) | Team dashboard (Epic 10 — placeholder) |

The CLI workspace package is named `@intentsolutions/jrig-cli`; the published bin is `j-rig`. The remaining internal packages still use their `@j-rig/*` workspace names for single-package commands, e.g. `pnpm --filter @j-rig/core run build`.

### Install the eval CLI in an external repo

```bash
# Global — gives you the `j-rig` command everywhere
npm install -g @intentsolutions/jrig-cli
# Or per-repo (recommended for CI version-pinning)
pnpm add -D @intentsolutions/jrig-cli   # then: pnpm exec j-rig --help
```

The published artifact is self-contained (bundles the private eval engine); its only runtime deps are real npm packages (`better-sqlite3` native addon, `@intentsolutions/refiner`, `@intentsolutions/core`, `drizzle-orm`, `zod`, …). DeepSeek (`deepseek-v4-flash`) is reached by setting `DEEPSEEK_API_KEY` in the environment and selecting it: `j-rig eval ./skill --spec ./eval-spec.yaml --provider deepseek`. Cut a release by bumping `packages/cli/package.json#version` via PR, merging, then tagging `jrig-cli-v*.*.*` from main HEAD (workflow `.github/workflows/publish-jrig-cli.yml`).

```bash
pnpm install                  # Install all workspace dependencies
pnpm run build                # Build all packages (tsup)
pnpm run test                 # Run vitest
pnpm run lint                 # ESLint (flat config, typescript-eslint)
pnpm run format:check         # Prettier check
pnpm run typecheck            # tsc --noEmit across all packages + tests/
pnpm run check                # Full validation (lint + format:check + typecheck + test)

# Single-package operations
pnpm --filter @j-rig/core run build
pnpm --filter @intentsolutions/jrig-cli run build   # builds the bundled CLI
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

Implementation stack: commander, chalk, zod, better-sqlite3, drizzle-orm. The Anthropic provider speaks the Messages API wire format directly through an injectable `Transport` seam rather than the `@anthropic-ai/sdk` (no added SDK dependency). The same `Transport` seam backs the OpenAI-Chat-Completions adapter (`providers/openai-compatible.ts`) covering DeepSeek (`deepseek-v4-flash`, env `DEEPSEEK_API_KEY`), Kimi/Moonshot, OpenRouter, Groq (`llama-3.3-70b-versatile`), NVIDIA NIM (`meta/llama-3.3-70b-instruct`), and OpenAI (`gpt-4o-mini`) — one adapter, no per-vendor SDK. The preset table mirrors the Skill Refiner provider registry (`@intentsolutions/refiner`), so `j-rig eval --provider <name>` and `refine score --provider <name>` resolve the same backend.

### Skill-scoring layer (epic intent-eval-lab#206 / ISEDC DR-103)

Consumes `@intentsolutions/core@^0.9.0` (the kernel minor that added the `usage_events` + `human_reviews` entities). Three surfaces:

- **Adoption signal** (`@intentsolutions/refiner-core` `adoption.ts`): `computeAdoptionVerdict()` — a deterministic time-decay adoption rate joined with the baseline-value flag into an advisory 2×2 (`keep` / `watch` / `deprecate_review` / `obsolete_review` / `hold`). AND-combined never averaged (no rolled score — C3); `now`-injected; the Thompson bandit is **rejected** (DR-103 D5); advisory-and-deprecate-only via the additive `LaunchReport.adoptionVerdict?` field (the `RolloutDecision` union is **not** mutated); thresholds ship `provisional: true` until back-tested. `toAdoptionObservations()` re-applies the kernel anti-gaming invariant (`source_verified`) at ingestion.
- **Intake verbs** (`@intentsolutions/jrig-cli`): `j-rig ingest-skill <skill-id> --session-id … --source ci|plugin [CASS flags]` (CASS gate ≥0.30, persist-but-exclude — no force-count) and `j-rig review <skill-id> --verdict up|down [--rationale …]` (curated-signal, NOT a signed `human-review/v1` predicate). Both write local SQLite via `@j-rig/db`; no OTel events minted.
- **Determinism fix**: `buildLaunchReport` now takes an injected clock (`opts.now`) so the launch-report artifact is replayable (DR-103 D5 B5.1) — the determinism the bandit-rejection rests on.

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
- Releases: tag-triggered, no auto-bump. For a repo-level GitHub Release, an engineer opens a PR bumping the **root** `package.json#version` + CHANGELOG, merges to main, then tags from main HEAD; `.github/workflows/release.yml` builds the Release on a `v*.*.*` tag and **verifies the tag matches the root `package.json#version`** (the previous auto-bump-on-push-to-main logic was removed). The published **CLI** follows a separate flow: bump `packages/cli/package.json#version`, then tag `jrig-cli-v*.*.*` (`publish-jrig-cli.yml`; see "Cut a release" above).

## Nightly skill-eval roster

Canonical roster: `eval-roster/roster.json` (14 skills as of 2026-07-23).

- **Source pin:** `jeremylongshore/claude-code-plugins-plus-skills` at a fixed git SHA (never floating `main`).
- **Latest growth:** skill-creator added after CCPI#1118 shipped its hand-authored `eval-spec.yaml` ([j-rig#234](https://github.com/jeremylongshore/j-rig-skill-binary-eval/pull/234)).
- **Rule:** a skill joins the roster only when `SKILL.md` + `eval-spec.yaml` both exist at the pinned path.
- Runner: `eval-roster/run-roster.mjs` + `.github/workflows/nightly-skill-evals.yml`.

## AI code review — BOTH REVIEWERS ARE DARK (do not wait for one)

**As of 2026-07-22 no AI reviewer runs on this repo.** Verified by surveying the
last four PRs across all six Intent Eval Platform repos: `gemini-code-assist`
now posts only a sunset notice, and `greptile` has zero activity anywhere.

- **Gemini Code Assist** — **SUNSET, permanently.** The consumer version on
  GitHub has ceased all review activity; the bot says so verbatim on live PRs.
  `.gemini/config.yaml` + `.gemini/styleguide.md` are retained but INERT. This
  is a vendor decision — it is not a quota that resets and it is not coming back.
- **Greptile** (`.greptile/config.json` + `rules.md` + `files.json`) — configured
  to the platform-unified schema (`strictness: 3`, `commentTypes:
["logic","syntax"]`, `statusCheck: false`, a universal `no-gate-weakening`
  rule, plus this repo's scoped invariant rules) but **not observed reviewing
  any PR**. The config stays so the App works if it is reinstalled; do not treat
  it as an expected reviewer today.

**Operationally: never block a merge waiting for an AI review.** Check whether
one arrived, read it if so, and otherwise proceed on CI. The deterministic merge gate is this repo's own CI (`pnpm run check` (lint + format:check + typecheck + test)) plus CodeQL. That was
always the required gate; it is now the only one. Installing or uninstalling the
GitHub Apps is an admin (UI) action — the in-repo config here does not do it.

**Replacement (decided 2026-07-22, not yet activated):** stand up the advisory
lane we already run on the marketplace repo —
`claude-code-plugins/.github/workflows/minimax-review.yml`. The action is
[`tarmojussila/minimax-code-review`](https://github.com/tarmojussila/minimax-code-review)
(the upstream mechanism), consumed via our own fork
`jeremylongshore/minimax-code-review` **pinned to an immutable SHA** — the right
supply-chain posture for a small single-maintainer action: we do not auto-track
upstream. It is fork-safe by construction (`pull_request`, not
`pull_request_target`, plus a same-repo guard, so a forked PR never receives the
API key) and kill-switched by repo variable.

**Do not copy CCPI's prompts.** The mechanism is generic; the value is prompts
grounded in the consuming repo's own invariants — CCPI's three lanes are written
against its validators and its A-grade bar and would be noise here. For this
repo the reviewer should be pointed at eval-harness correctness — judge determinism, the provider seam (no backend may become required), and Evidence Bundle emission conformance.

Activation needs owner secret actions: repo secret `MINIMAX_API_KEY` + repo
variable `ENABLE_MINIMAX_REVIEW=true` (+ `MINIMAX_MODEL`). Until then this repo
is CI-only, deliberately.

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
