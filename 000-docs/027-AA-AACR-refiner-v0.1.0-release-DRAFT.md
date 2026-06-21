# Skill Refiner npm Release — `@j-rig/refiner-core` + `@j-rig/refiner` v0.1.0 (DRAFT)

**Filing**: 027-AA-AACR-refiner-v0.1.0-release-DRAFT.md
**Date**: 2026-06-21
**Author**: Jeremy Longshore (release prep; executed by Claude)
**Status**: **DRAFT** — release machinery is wired but **NOT published**. No `refiner-v*` tag has been pushed. Finalize this doc after the first real publish (fill the post-publish placeholders in § 7).
**Bead**: `bd_000-projects-3zol.8` (Refiner library release prep — PREP ONLY)
**Plan**: `intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md` (v5, ratified via DR-028)
**Binding scope decision**: DR-028 T4 — KEEP-NAMED-PRODUCT (`@j-rig/*` scope; do NOT rename to `@intentsolutions`)

---

## 1. What this release ships

The first public npm release of the Skill Refiner library pair — the second
product in the IS three-product agent-rig stack (**J-Rig Skill Binary Eval**
[test] → **Skill Refiner** [improve] → **Rollout Gate** [ship]):

| Package | Role | Tarball contents |
| --- | --- | --- |
| `@j-rig/refiner-core@0.1.0` | Pure foundation — value types, bounded-edit apply, deterministic eval-set bootstrap, the Pareto-dominant acceptance gate, the swappable RefinerStrategy interface | `dist/` only |
| `@j-rig/refiner@0.1.0` | Orchestrator + I/O adapters + CLI — content-addressed store, j-rig `score()` shell-out adapter, tiered Anthropic `propose()` adapter, the `j-rig refine` commands | `dist/` only |

Both publish with **sigstore provenance** (npm OIDC keyless) via a single tag
push, `refiner-v0.1.0`.

This is the **Phase A wave-1 + wave-2 surface** of the Refiner plan. The
following are deliberately NOT in v0.1.0 (gated / later waves): the
`SkillVersion` kernel entity (14th canonical entity, DR-028 T1), the
`skill-refiner-pass/v1` predicate URI + signed evidence emission, and the Claude
Code plugin + 3-layer hooks. See the plan's "Deferred / still-gated" sections.

## 2. What each package exports

### `@j-rig/refiner-core` (pure, no I/O)

- **Value types** — `SkillDoc`, `EditOp`/`EditProposal`, `ScoreRecord`,
  `EvalSet`/`EvalItem`/`EvalSetRef`, `AcceptResult`, content-address aliases
  (`Sha256`, `SkillDocHash`, `EvalSetHash`).
- **Content addressing** — `sha256`, `canonicalJson`, `hashSkillDoc`, `hashValue`.
- **Pure operations** — `applyEdit` (bounded-edit transform) + `EditApplicationError`,
  `bootstrap` (deterministic synthetic eval-set), `accept` /
  `isSignificantImprovement` / `isSignificantRegression` (the DR-028 P0-RATIFY-1
  acceptance gate).
- **EvalSet machinery** — Zod schemas + `validateEvalSet`, `deriveEvalSetRef`,
  `isRefreshDue`, the UUID/SHA regexes.
- **Cost meter** — `createCostMeter`, `totalTokens`, budget/quarantine types.
- **Swappable mechanism (AC-13)** — the `RefinerStrategy` interface + its two
  reference implementations (re-exported from `./strategies`).
- **Version-pinning contracts** — `CONSUMED_KERNEL_VERSION` (`0.8.0`),
  `CONSUMED_JUDGE_VERSION` (`claude-sonnet-4-5`), and the baseline-supersession
  triggers that fire when the consumed kernel or judge version moves.
- **Decision matrix** — `decide` + the 4-quadrant schema-validity × judge-verdict
  outcome types, the kernel-backed `kernelSkillFrontmatterValidator`.
- **Eval-set quality metrics** — `coverage`, `leakage`, `calibration`,
  `adversarialPassRate`, `evaluateEvalSet`.

### `@j-rig/refiner` (I/O half — depends on refiner-core)

- **Persistence** — `RefinerStore` (content-addressed store + append-only event
  log + single mutable best-pointer) + `createNodeFileSystem` + the `FileSystem`
  injection seam.
- **`score()` adapter** — delegates to the existing `j-rig eval` via an injectable
  shell-out (`createSubprocessEvalRunner`), maps output → a refiner-core
  `ScoreRecord`.
- **`propose()` adapter** — an injectable, tiered (`haiku`|`sonnet`, **never
  opus** per AC-5) Anthropic-backed `RefinerModel`
  (`createRefinerModel` / `resolveProposeModelId` / `assertNotOpus`).
- **CLI** — `registerRefineCommand`, wiring the five `j-rig refine <cmd>` commands.

## 3. The `@j-rig/*` scope decision (DR-028 T4)

The published scope is **`@j-rig/*`**, ratified as **KEEP-NAMED-PRODUCT** in
ISEDC Session 7 (DR-028 T4,
`intent-eval-lab/000-docs/028-AT-DECR-isedc-council-session-7-skill-refiner-plan-ratification-2026-05-27.md`).
This is a deliberate, council-ratified decision — the Skill Refiner ships under
the J-Rig product brand, NOT under the `@intentsolutions` org scope used by the
canonical kernel (`@intentsolutions/core`) and the rollout-gate decision library
(`@intentsolutions/rollout-gate`). Do **not** "normalize" these names to
`@intentsolutions/*`; that would contradict a binding DR.

The `@j-rig/refiner → @j-rig/refiner-core` dependency is declared `workspace:*`
in the monorepo. pnpm rewrites that to the concrete `0.1.0` at publish time
(verified by `pnpm pack` during prep); the publish workflow asserts the rewrite
landed via a post-publish guard that fails loudly if any literal `workspace:`
reaches the tarball.

## 4. Version-pinning + breaking-change policy

- **Lockstep versions.** `@j-rig/refiner-core` and `@j-rig/refiner` share one
  version number and are cut together by a single `refiner-v<version>` tag. The
  publish workflow's drift-guard refuses to publish unless the tag matches BOTH
  package.json versions exactly. Bump both in the same release PR.
- **SemVer.** v0.x is pre-1.0: minor bumps may carry breaking changes, but every
  break is called out in the release notes. After v1.0.0, the public export
  surface in § 2 is the SemVer contract — removing/retyping a re-exported symbol
  is a major bump.
- **Kernel pin.** `@j-rig/refiner-core` consumes `@intentsolutions/core@0.8.0`
  (`CONSUMED_KERNEL_VERSION`), declared as both a `peerDependency` (`^0.8.0`) and
  a direct `dependency` (`0.8.0`). A kernel major/minor that changes consumed
  contracts triggers a refiner re-baseline (the `isBaselineSupersededByKernel`
  path) and a coordinated refiner version bump.
- **Judge pin.** `CONSUMED_JUDGE_VERSION = claude-sonnet-4-5`. A judge-model move
  fires the vNext-baseline trigger; baselines measured under the old judge are
  marked superseded.

## 5. Consumer integration — adding `@j-rig/refiner` to a skill's CI

Once published, a skill repo gates SKILL.md changes on a Refiner pass like this
(illustrative — the predicate-URI signed-evidence leg is gated and lands in a
later wave):

```bash
pnpm add -D @j-rig/refiner @j-rig/refiner-core
# refiner-core is pulled transitively; add it explicitly only if you import the
# pure types directly in your own gate scripts.
```

```yaml
# .github/workflows/skill-refine-gate.yml (sketch)
- run: pnpm add -D @j-rig/refiner
- run: pnpm exec j-rig refine check --skill ./SKILL.md
  # The acceptance gate accepts a proposed edit only on strict improvement on a
  # Pareto-dominant behavioral dimension with non-regressing others
  # (DR-028 P0-RATIFY-1). The skill under test never judges itself.
```

Library (non-CLI) consumers import the pure core directly:

```ts
import { accept, applyEdit, bootstrap } from "@j-rig/refiner-core";
import { RefinerStore, score, propose } from "@j-rig/refiner";
```

## 6. Release machinery (what prep landed)

- **`packages/refiner-core/package.json` + `packages/refiner/package.json`** —
  un-privated (`private: true` removed), added
  `publishConfig {access: public, provenance: true, registry}`, and filled the
  standard publish metadata (`description`, `keywords`, `homepage`, `bugs`,
  `repository` with `directory`, `license: Apache-2.0`, `author`) to match the
  intent-eval-core / rollout-gate idiom. Names + `0.1.0` version unchanged;
  `workspace:*` dep left intact (pnpm rewrites at publish).
- **`.github/workflows/publish-refiner.yml`** — tag-triggered on
  `refiner-v*.*.*` (separate namespace from `v*` and `rollout-gate-v*`).
  Pins the checkout to the tag (reproducible-from-tag CISO invariant),
  drift-guards the tag against BOTH package versions, runs the full gate
  (`build` + `check`), publishes **refiner-core first then refiner** with
  `--provenance`, and asserts the published refiner tarball rewrote its
  `workspace:` dep.

## 7. Post-publish — TO FILL on the real release

> **DRAFT placeholders.** This release is **GATED on the `@j-rig` npm org
> existing under the publishing account** (the `NPM_TOKEN` secret must be scoped
> to publish `@j-rig/*`). Until that org is provisioned and the first
> `refiner-v0.1.0` tag is pushed, the items below are unknown.

- npm: `https://www.npmjs.com/package/@j-rig/refiner-core` — _TBD on publish_
- npm: `https://www.npmjs.com/package/@j-rig/refiner` — _TBD on publish_
- Sigstore provenance (refiner-core) Rekor logIndex: _TBD_
- Sigstore provenance (refiner) Rekor logIndex: _TBD_
- `npm audit signatures` verification result: _TBD_
- Workflow run URL: _TBD_

When this is filled, rename this file from `...-DRAFT.md` to drop the `-DRAFT`
suffix and update its INDEX row.
