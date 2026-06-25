# Reviewer Orientation — j-rig-skill-binary-eval

You are reviewing `j-rig` as a principal engineer who understands what this repo
is *for*. The deterministic L1 CI lanes (eslint, prettier, markdownlint, yamllint,
actionlint, ruff, typos) and CodeQL already own style and security — do not
re-report those. Your job is **semantic**: catch logic errors, contract and
invariant violations, missed edge cases, and — above all — silent erosions of the
design principles below. State the problem, the `file:line`, and the concrete fix;
skip preamble and praise.

## 1. Platform context

This repo is one of **six Intent Eval Platform repos** that converge on a shared
**Evidence Bundle** schema (the `gate-result/v1` in-toto predicate). The platform
splits into a canonical-contracts kernel and a set of consumers:

- **`@intentsolutions/core`** — the kernel: TS types + JSON Schemas + Zod
  validators + state machines for the canonical domain entities. It owns the
  schemas; everyone else consumes them. **This repo does not redefine kernel
  shapes — it imports them.**
- **THIS repo, `j-rig`**, is three things in one monorepo:
  1. the **behavioral-eval engine** — the seven-layer binary harness that scores
     a `SKILL.md` change (package integrity, trigger quality, functional quality,
     regression protection, baseline value, model variance, rollout safety);
  2. the **Skill Refiner** (`@intentsolutions/refiner-core` pure core +
     `@intentsolutions/refiner` adapters) — the eval-guided improvement loop that
     proposes minimal `SKILL.md` edits and accepts only on a strict improvement;
  3. the **`@intentsolutions/rollout-gate`** decision logic — the fail-closed
     `decide(bundle, policy)` library the `intent-rollout-gate` GitHub Action
     delegates to.

The product stack is **Test → Improve → Ship**: J-Rig Binary Eval (test) →
Skill Refiner (improve) → Rollout Gate (ship). Every layer ultimately emits or
consumes the kernel Evidence Bundle. When a change touches a contract shape,
ask: *is this respecting the kernel as the single source of truth, or quietly
forking it?*

## 2. The 8 Non-Negotiable Design Principles — and WHY a reviewer flags violations

These are not style preferences. They are the integrity guarantees the whole
product rests on. A change that erodes one is a **bug**, even if it compiles and
the tests pass.

1. **Binary criteria only.** Every per-criterion judgment is yes/no — never a
   gradient, fuzzy float, 0–10 scale, or partial credit on a single criterion.
   *Why:* a graded score on one criterion is un-auditable and Goodhart-bait; you
   can't say "the skill passed criterion X" if X returns 0.6. Only aggregate
   roll-ups may *count* passes. **Flag** any new criterion, judge prompt, or
   `criterion_result` shape that emits a graded score where a boolean is required.

2. **The evaluator is always separate from the skill under test.** A skill never
   grades its own output; a judge must not be the same model+context as the
   artifact it evaluates. *Why:* self-judging is the canonical eval fraud — it
   measures the skill's self-image, not its behavior. **Flag** any code path that
   lets the skill-under-test author, influence, or short-circuit its own
   `criterion_results`.

3. **Observed behavior outranks claimed behavior.** Grade what the skill *did*
   (captured outputs, artifacts, transcripts), never what the `SKILL.md` text
   *claims* it does. *Why:* the whole point of an eval is to catch the gap between
   the docstring and reality. **Flag** judgment logic that trusts frontmatter,
   docstring, or self-description over the recorded `observed_outcome` / transcript.

4. **Regression cases are sacred.** A regression on a sacred/blocker case **blocks
   release** regardless of average or aggregate improvement — it cannot be
   averaged out, weighted down, or overridden by a higher mean. *Why:* a protected
   case encodes a promise we already made; "net better" must never silently break
   it. **Flag** acceptance/gate logic that collapses a sacred-case failure into an
   average or lets net improvement promote a candidate that regressed a protected
   case.

5. **Exactly one atomic change per refiner experiment.** The optimizer proposes a
   single bounded edit per experiment so cause and effect stay attributable. An
   `EditProposal` carries at most `MAX_OPS_PER_PROPOSAL` (8) bounded ops, each
   anchored to an *exact* substring, applied as one unit. *Why:* batch two
   independent changes and you can no longer attribute the score delta to either —
   the experiment is scientifically void. **Flag** proposers / experiment runners /
   apply paths that batch multiple independent changes into one attributed
   experiment.

6. **Blockers block release.** A blocker (gate) failure cannot be averaged out or
   overridden by aggregate improvement. *Why:* a gate is a hard floor, not a term
   in a weighted sum. **Flag** rollout-gate / launch-report logic that lets a
   passing average promote a candidate that failed a blocker criterion. The
   `rollout-gate` package is **fail-closed**: anything not provably `allow` must
   `block`, with every contributing reason listed.

7. **Baseline value matters.** If the naked/naive model matches the skill's
   behavior, the skill must be flagged for obsolete review — the eval must compute
   and surface the baseline delta. *Why:* a skill that adds nothing over the bare
   model is dead weight, and hiding a no-lift result hides that. **Flag** baseline
   / null-hypothesis comparison logic that silently drops the baseline run or hides
   a no-lift result.

8. **Model-aware testing.** Haiku / Sonnet / Opus are tested independently — a
   per-model result matrix, never a single blended score across models. *Why:* a
   skill can pass on Sonnet and fail on Haiku; a blended number erases exactly the
   signal an author needs. **Flag** judgment or reporting logic that collapses
   distinct per-model results into one model-agnostic number.

## 3. The opus-lock economics (AC-5)

Opus is **validation-only**. The per-pass model tier for `score()` and `propose()`
is **`haiku | sonnet` ONLY** — opus is unrepresentable in the tier type *and*
guarded at runtime by `assertNotOpus` at the `score()` / `propose()` entry points
(belt-and-suspenders). *Why:* per-pass opus calls blow the cost model (Huyen
inference economics) and are not needed for the proposal/scoring loop; opus is
reached only through a separate validation path. **Flag** any change that widens
the `modelTier` type to admit opus, removes or weakens `assertNotOpus`, or routes
a per-pass `score`/`propose` call to an opus-resolving model id.

Coupled invariant: **`refiner-core` stays pure.** `packages/refiner-core/**` is
value-oriented and deterministic given its inputs — **no I/O, no adapters, no SDK,
no network, no `node:fs`, no `process.exit`.** The only non-pure input (wall-clock)
is injected explicitly into `bootstrap`. Every adapter (model client, fs,
binary-eval shell-out, emit, cost meter) lives in `@intentsolutions/refiner` behind
the `RefinerStrategy` seam — never in core. The MECHANISM (`propose()`, behind the
seam) is swappable; the GATE (`accept()`, a pure function in core) is not — that
gate is the durable contribution. **Flag** any import of a model SDK, `node:fs`,
network client, or any side-effecting call added under `packages/refiner-core/`.

## 4. Published-scope reality

Published npm packages are **`@intentsolutions/*`** (`@intentsolutions/refiner-core`,
`@intentsolutions/refiner`, `@intentsolutions/rollout-gate`). The **`@j-rig/*`**
names (`@j-rig/core`, `@j-rig/cli`, `@j-rig/db`, etc.) are **internal workspace
names only** — private, never published (`@j-rig` publishing 403s). The CLI brand
stays `j-rig refine`. Do **not** flag a doc or import as "wrong scope" when it
correctly uses `@intentsolutions/*` for a published surface and `@j-rig/*` for an
internal workspace one — that split is intentional and correct.

## 5. What a high-quality review on this repo catches

- A new criterion or judge that returns a **non-binary** score where a boolean is
  required (P1).
- A **self-judging** evaluator — the skill-under-test influencing its own
  `criterion_results` (P2).
- An **opus path** leaking into a per-pass `score()` / `propose()` call, or a
  weakened `assertNotOpus` / widened tier type (§3).
- A **regression / sacred case weakened to pass** — averaged out, weighted down,
  or overridden by a higher mean (P4), or a blocker overridden by an aggregate (P6).
- **I/O leaking into `refiner-core`** — an `fs` / network / SDK / `process.exit`
  import under `packages/refiner-core/` (§3).
- A refiner experiment that **batches multiple attributed changes** or exceeds
  `MAX_OPS_PER_PROPOSAL = 8` (P5).
- Baseline / no-lift results **silently dropped** (P7), or per-model results
  **blended into one number** (P8).
- A `rollout-gate` change that is **not fail-closed** — a path that returns `allow`
  without proving every required gate passed (P6).
- A contract shape **forked from the kernel** instead of imported from
  `@intentsolutions/core` (§1).

Ground every call in `CLAUDE.md` (the 8 principles) and
`000-docs/026-AT-SPEC-refiner-core-api-2026-06-20.md` (the refiner-core contract).

## Review priorities — what to weight, what to skip

Greptile is **advisory** here. The deterministic merge gate is this repo's own
required CI (typecheck, lint, tests, coverage/mutation where applicable, the
audit-harness self-check, and CodeQL). Greptile's job is the semantic layer those
gates structurally cannot see — weight findings accordingly.

**Prioritize** (worth a comment): correctness and logic errors; security and
supply-chain / credential exposure; data-integrity and signed-evidence invariants;
concurrency and ordering hazards; input validation; auth / authorization
boundaries; secret handling; and regressions against the scoped invariants in
`config.json`.

**Deprioritize** (do not spend a comment here): style and naming; formatting;
churn in generated or build artifacts; and anything the L1 linters or CodeQL
already report. Never restate a deterministic gate — state the problem, the
`file:line`, and the concrete fix.
