# TEST_AUDIT.md — j-rig-binary-eval

> Diagnostic produced by `/audit-tests` (7-layer + gate sweep). Date: 2026-07-13.
> Scope: the whole pnpm workspace — the `jrig` CLI + `refiner` CLI and the seven
> library/decision-logic packages they compose. Every claim below is grounded in a
> real run of the repo's own commands (`pnpm run test:coverage`,
> `test:coverage:refiner-core`, `scripts/audit-harness {verify,escape-scan,arch,bias,crap}`),
> not inferred from config.

## Grade: B+ (88/100)

Genuinely strong, heavily-gated posture: **84 test files / 1407 tests all green**,
aggregate coverage comfortably above a ratchet-from-here floor, a **second dedicated
per-package coverage gate** for the critical `refiner-core` decision logic, and a full
hard-gate chain (lint, format, strict types, coverage floors, hash-pinned harness,
escape-scan, CodeQL, markdown/yaml/actions/typos) enforced in CI **and** mirrored in a
local husky pre-commit. Held below A− by one pointed gap and one degraded gate: **no
mutation testing** anywhere (the single highest-value missing layer for a product whose
entire thesis is *evaluation rigor* — high line coverage without mutation is exactly the
"coverage theater" j-rig exists to catch), and the **CRAP gate passes vacuously** because
`complexity-report` isn't installed, so it measures no JS complexity. Secondary: the
`dashboard` package ships **0 tests** (unwaived), and there are no RTM/PERSONAS/JOURNEYS
traceability docs nor a deterministic layering (dep-cruiser) gate.

## Classification

**Monorepo — dual-CLI + library set.** pnpm workspace (`packages/*`), 9 packages:

| Package | Name | Role | Test files |
|---|---|---|---|
| cli | `@intentsolutions/jrig-cli` | CLI (operator surface) | 17 |
| core | `@j-rig/core` | library — schemas, providers, scoring, triggers | 34 |
| refiner-core | `@intentsolutions/refiner-core` | decision-logic library (own coverage gate) | 14 |
| refiner | `@intentsolutions/refiner` | CLI — skill-refiner orchestration | 6 |
| migrate | `@j-rig/migrate` | codemod library | 4 |
| db | `@j-rig/db` | SQLite persistence library | 2 |
| pr-comment | `@j-rig/pr-comment` | PR-render library | 2 |
| rollout-gate | `@intentsolutions/rollout-gate` | decision-logic library | 2 |
| dashboard | `@j-rig/dashboard` | presentation | **0** |

Plus root `tests/` (integration + smoke) and `scripts/` (2 tool tests). Toolchain: **Node
≥20 / pnpm 10.8.1 / vitest 3 + @vitest/coverage-v8** (this is a Node/pnpm repo — not Bun).

## 7-layer presence / config / enforcement

| Layer | State | Evidence |
|---|---|---|
| L1 — git hooks & CI | ✅ HARD | `.husky/pre-commit` (escape-scan `--staged` + `lint-staged`; installed via `prepare: husky`) + a maintained husky-equivalent `lefthook.yml` (pre-push = `pnpm run check`). CI: `ci.yml` (lint / typecheck / test / otel-smoke) + `codeql.yml`, `doc-quality.yml` (markdownlint + lychee + advisory Vale), `lint.yml` (yamllint `--strict` + actionlint), `typos.yml` |
| L2 — static / lint / types | ✅ HARD | ESLint 10 + typescript-eslint (`pnpm run lint`), Prettier `format:check`, **strict `tsc --noEmit`** over both `tests/tsconfig.json` and every package (`pnpm -r run typecheck`), yamllint/actionlint, markdownlint, typos, **CodeQL `security-extended`** (js-ts + python) |
| L3 — unit & function | ✅ HARD | **84 `*.test.ts` / 1407 tests, 100% pass**; aggregate coverage floor (`vitest.config.ts` thresholds, hash-pinned) **plus** a dedicated scoped floor for `refiner-core` (`test:coverage:refiner-core`, its own hash-pinned config) |
| L4 — integration | ✅ | root `tests/` = declared cross-package integration; `core` exercises the real providers + scoring path; `db` covers lifecycle/evidence/schema against real SQLite; `migrate` runs real codemod transforms |
| L5 — system quality | ◑ partial | `scripts/otel-smoke.sh` is a real end-to-end emission smoke — runs a full stub-provider eval with `J_RIG_OTEL=1` and asserts every 067-taxonomy event name fires with `eval.run_id` (gated as its own CI job). `tests/smoke.test.ts` itself is trivial (`1+1`). No live-provider system leg in CI (by design) |
| L6 — E2E | ◑ partial | CLI end-to-end exercised via the 17 `cli` tests + the full-eval `otel-smoke` job; **no dedicated E2E/gherkin pack** (0 `.feature` files) |
| L7 — acceptance / business | ◑ partial | `evidence/dogfood` + `evidence/dogfood-full` self-eval bundles (j-rig evaluating its own skill — `run.json` + `evidence-bundle.json`); **no RTM/PERSONAS/JOURNEYS traceability docs** tying requirements → tests |

## Deterministic gates (measured 2026-07-13)

| Gate | Result |
|---|---|
| test suite | **PASS** — 84 files / 1407 tests, 0 failures |
| coverage (aggregate) | **PASS** — lines/stmts 79.36% (floor 73), branches 86.02% (floor 84), funcs 88.75% (floor 80) |
| coverage (`refiner-core` scoped) | **PASS** — 327 tests; lines/stmts 97.23%, branches 91.07%, funcs 100% (floor 80 all dims) |
| ESLint + Prettier | enforced in CI `lint` job (`pnpm run lint` + `format:check`) |
| strict typecheck | enforced (`tsc --noEmit` on tests + `-r` packages) |
| audit-harness `verify` (hash-pin) | **OK** — v1.1.5; pins `vitest.config.ts` + `packages/refiner-core/vitest.config.ts` so a silent floor downgrade trips HARNESS_TAMPERED |
| escape-scan (`--staged`) | **PASS** — REFUSE=0 CHALLENGE=0 FLAG=0 |
| audit-harness `bias` | **PASS** — 0 bias patterns |
| audit-harness `arch` | ⚠️ **not-configured** — no dep-cruiser config; 0 violations because nothing is checked |
| audit-harness `crap` | ⚠️ **degraded** — reports `{"pass": true}` but `complexity-report` is not installed, so the JS complexity/CRAP metric is a no-op (vacuous pass) |
| mutation testing | ❌ **ABSENT** — no Stryker config or dependency anywhere |
| markdownlint / yamllint / actionlint / typos / lychee | enforced across `doc-quality.yml` + `lint.yml` + `typos.yml` |
| CodeQL `security-extended` | enforced (`codeql.yml`) |
| Codecov | wired — per-package components, project `auto` + 2% slack, patch 50% |

## Gaps

**P0:** none. The hard-gate chain is real and enforced in CI + locally; the suite is
large, green, and above floor on every dimension.

**P1:**

- **No mutation testing.** For an evaluation-rigor product — especially the pure
  decision-logic packages (`rollout-gate`, `refiner-core`, `core` scoring) — mutation
  testing is the layer that proves the 1407 assertions actually *catch* defects rather
  than just execute lines. High v8 coverage (79–97%) with zero mutation is the exact blind
  spot j-rig itself is built to expose. Highest-value add: a Stryker config scoped first to
  the decision-logic packages, wired as a CI job with a survivor threshold.
- **CRAP gate passes vacuously.** `scripts/audit-harness crap` emits
  `complexity-report not installed` and then `{"pass": true}` — the gate is green but
  measures no JavaScript complexity. Either install `complexity-report` (so CRAP actually
  scores) or explicitly waive/remove the gate so a green result isn't misread as signal.

**P2 (logged):**

- **`dashboard` package has 0 tests** and is not declared as a waived/presentation-only
  layer — either add smoke coverage or record an explicit waiver.
- **No `tests/RTM.md` / `PERSONAS.md` / `JOURNEYS.md`** requirements-traceability docs; for
  a nine-package monorepo the requirement→test mapping is currently implicit.
- **No dep-cruiser layering config** — the `arch` gate is `not-configured`, so the monorepo
  layering invariant (leaf packages must not import CLIs; `@j-rig/core` as the base) is
  unenforced deterministically. A small `.dependency-cruiser.cjs` would close it and light
  up the existing `arch` gate.
- **Coverage floors sit ~6 pts below measured** (73/73/80/84 vs 79/86/88); the
  ratchet-from-here headroom is unused. Acceptable by design, but a modest floor bump would
  bank the current gains against regression.

## Handoff

**Recommended → `/implement-tests`** for the two P1 items — scaffold Stryker (scoped to the
decision-logic packages first) and either install `complexity-report` or waive the CRAP
gate. The P2 items (dashboard smoke, RTM/traceability docs, dep-cruiser arch config, floor
ratchet) are low-risk follow-ups that can be filed as beads rather than blocking work.
