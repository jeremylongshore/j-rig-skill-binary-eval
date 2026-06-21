# Skill Refiner npm Release — `@intentsolutions/refiner-core` + `@intentsolutions/refiner` v0.1.0

**Filing**: 027-AA-AACR-refiner-v0.1.0-release-2026-06-21.md
**Date**: 2026-06-21
**Author**: Jeremy Longshore (release prep; executed by Claude)
**Status**: **PUBLISHED** — both packages are live on npm at v0.1.0 with SLSA provenance v1 attestations (keyless sigstore via GitHub Actions OIDC). The `refiner-v0.1.0` tag triggered the publish workflow (run 27916699310, all green). Post-publish facts are filled in § 7.
**Bead**: `bd_000-projects-3zol.8` (Refiner library release prep → published)
**Plan**: `intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md` (v5, ratified via DR-028)
**Scope decision**: Published as `@intentsolutions/*` per CEO directive 2026-06-21 (overrides DR-028 T4 published-name detail — see § 3).

---

## 1. What this release ships

The first public npm release of the Skill Refiner library pair — the second
product in the IS three-product agent-rig stack (**J-Rig Skill Binary Eval**
[test] → **Skill Refiner** [improve] → **Rollout Gate** [ship]):

| Package | Role | Tarball contents |
| --- | --- | --- |
| `@intentsolutions/refiner-core@0.1.0` | Pure foundation — value types, bounded-edit apply, deterministic eval-set bootstrap, the Pareto-dominant acceptance gate, the swappable RefinerStrategy interface | `dist/` only |
| `@intentsolutions/refiner@0.1.0` | Orchestrator + I/O adapters + CLI — content-addressed store, j-rig `score()` shell-out adapter, tiered Anthropic `propose()` adapter, the `j-rig refine` commands | `dist/` only |

Both publish with **sigstore provenance** (npm OIDC keyless) via a single tag
push, `refiner-v0.1.0`.

This is the **Phase A wave-1 + wave-2 surface** of the Refiner plan. The
following are deliberately NOT in v0.1.0 (gated / later waves): the
`SkillVersion` kernel entity (14th canonical entity, DR-028 T1), the
`skill-refiner-pass/v1` predicate URI + signed evidence emission, and the Claude
Code plugin + 3-layer hooks. See the plan's "Deferred / still-gated" sections.

## 2. What each package exports

### `@intentsolutions/refiner-core` (pure, no I/O)

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

### `@intentsolutions/refiner` (I/O half — depends on refiner-core)

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

## 3. Scope decision — `@intentsolutions/*` (CEO directive 2026-06-21)

**Published under `@intentsolutions/*`** per CEO directive issued 2026-06-21,
overriding the published-name detail of DR-028 T4 (KEEP-NAMED-PRODUCT).

**Rationale for the override:** The existing `NPM_TOKEN` secret (account
`intentsolutionsio`) already owns and scopes-publishes `@intentsolutions/*` — it
is the same token that published `@intentsolutions/core@0.1.0`,
`@intentsolutions/rollout-gate@2.0.0`, and `@intentsolutions/audit-harness`.
Publishing under `@j-rig/*` would have required creating a separate npm
organization (`@j-rig`) and provisioning a new token, adding operational overhead
and a new secret with no benefit. Consolidating under the existing
`@intentsolutions` org is consistent with every other IEP published artifact.

**What DR-028 T4 KEEP-NAMED-PRODUCT means in practice:** The J-Rig **brand** and
**CLI identity** are unchanged — the binary is still `j-rig`, the command is still
`j-rig refine`, and the product is still called "J-Rig Skill Binary Eval." Only
the npm artifact scope changed from the previously-planned `@j-rig/*` to
`@intentsolutions/*`. DR-028 T4 was ratified to prevent renaming the J-Rig
product to something opaque; this override preserves that intent while aligning
the publish account with the rest of the ecosystem.

The `@intentsolutions/refiner → @intentsolutions/refiner-core` dependency is
declared `workspace:*` in the monorepo. pnpm rewrites that to the concrete `0.1.0`
at publish time (verified by `pnpm pack` during prep); the publish workflow asserts
the rewrite landed via a post-publish guard that fails loudly if any literal
`workspace:` reaches the tarball.

## 4. Version-pinning + breaking-change policy

- **Lockstep versions.** `@intentsolutions/refiner-core` and `@intentsolutions/refiner` share one
  version number and are cut together by a single `refiner-v<version>` tag. The
  publish workflow's drift-guard refuses to publish unless the tag matches BOTH
  package.json versions exactly. Bump both in the same release PR.
- **SemVer.** v0.x is pre-1.0: minor bumps may carry breaking changes, but every
  break is called out in the release notes. After v1.0.0, the public export
  surface in § 2 is the SemVer contract — removing/retyping a re-exported symbol
  is a major bump.
- **Kernel pin.** `@intentsolutions/refiner-core` consumes `@intentsolutions/core@0.8.0`
  (`CONSUMED_KERNEL_VERSION`), declared as both a `peerDependency` (`^0.8.0`) and
  a direct `dependency` (`0.8.0`). A kernel major/minor that changes consumed
  contracts triggers a refiner re-baseline (the `isBaselineSupersededByKernel`
  path) and a coordinated refiner version bump.
- **Judge pin.** `CONSUMED_JUDGE_VERSION = claude-sonnet-4-5`. A judge-model move
  fires the vNext-baseline trigger; baselines measured under the old judge are
  marked superseded.

## 5. Consumer integration — adding `@intentsolutions/refiner` to a skill's CI

Now that both packages are public, a skill repo gates SKILL.md changes on a
Refiner pass like this (illustrative — the predicate-URI signed-evidence leg is
gated and lands in a later wave):

```bash
pnpm add -D @intentsolutions/refiner @intentsolutions/refiner-core
# refiner-core is pulled transitively; add it explicitly only if you import the
# pure types directly in your own gate scripts.
```

```yaml
# .github/workflows/skill-refine-gate.yml (sketch)
- run: pnpm add -D @intentsolutions/refiner
- run: pnpm exec j-rig refine check --skill ./SKILL.md
  # The acceptance gate accepts a proposed edit only on strict improvement on a
  # Pareto-dominant behavioral dimension with non-regressing others
  # (DR-028 P0-RATIFY-1). The skill under test never judges itself.
```

Library (non-CLI) consumers import the pure core directly:

```ts
import { accept, applyEdit, bootstrap } from "@intentsolutions/refiner-core";
import { RefinerStore, score, propose } from "@intentsolutions/refiner";
```

## 6. Release machinery (what shipped)

- **`packages/refiner-core/package.json` + `packages/refiner/package.json`** —
  un-privated (`private: true` removed), added
  `publishConfig {access: public, provenance: true, registry}`, and filled the
  standard publish metadata (`description`, `keywords`, `homepage`, `bugs`,
  `repository` with `directory`, `license: Apache-2.0`, `author`) to match the
  intent-eval-core / rollout-gate idiom. Names renamed to `@intentsolutions/refiner-core`
  / `@intentsolutions/refiner` per CEO directive 2026-06-21; `0.1.0` version
  unchanged; `workspace:*` dep left intact (pnpm rewrites at publish).
- **`.github/workflows/publish-refiner.yml`** — tag-triggered on
  `refiner-v*.*.*` (separate namespace from `v*` and `rollout-gate-v*`).
  Pins the checkout to the tag (reproducible-from-tag CISO invariant),
  drift-guards the tag against BOTH package versions, runs the full gate
  (`build` + `check`), publishes **refiner-core first then refiner** with
  `--provenance` under the `@intentsolutions` scope using the existing
  `NPM_TOKEN`, and asserts the published refiner tarball rewrote its
  `workspace:` dep.

## 7. Post-publish — release facts (2026-06-21)

Both packages published successfully under `@intentsolutions/*` from the
`refiner-v0.1.0` tag. The `@intentsolutions` org was already provisioned under
the publishing account (`intentsolutionsio`), so the `@j-rig`-org provisioning
that the draft anticipated was not required — the CEO scope directive in § 3 made
it moot.

### Published packages

| Package | Version | npm page |
| --- | --- | --- |
| `@intentsolutions/refiner-core` | `0.1.0` | <https://www.npmjs.com/package/@intentsolutions/refiner-core> |
| `@intentsolutions/refiner` | `0.1.0` | <https://www.npmjs.com/package/@intentsolutions/refiner> |

### Tarballs

- refiner-core: <https://registry.npmjs.org/@intentsolutions/refiner-core/-/refiner-core-0.1.0.tgz>
- refiner: <https://registry.npmjs.org/@intentsolutions/refiner/-/refiner-0.1.0.tgz>

### Provenance — SLSA provenance v1 via npm/GitHub sigstore

Both packages were published with `pnpm publish --provenance`, producing
**SLSA provenance v1 attestations** generated keyless via sigstore using the
GitHub Actions OIDC identity. The attestation bundles are served by npm:

- refiner-core: <https://registry.npmjs.org/-/npm/v1/attestations/@intentsolutions%2frefiner-core@0.1.0>
- refiner: <https://registry.npmjs.org/-/npm/v1/attestations/@intentsolutions%2frefiner@0.1.0>

Each endpoint returns two attestations: the npm publish attestation
(`https://github.com/npm/attestation/tree/main/specs/publish/v0.1`) and the SLSA
provenance v1 attestation (`https://slsa.dev/provenance/v1`).

> **No standalone Rekor logIndex.** Unlike our cosign keyless flow (e.g.
> intent-rollout-gate v0.2.0, which cites a discrete Rekor `logIndex`), the
> npm-provenance path does not surface a standalone Rekor transparency-log index
> through the registry attestation API. Verification is via the npm attestation
> endpoints above plus `npm audit signatures`; do not expect a cosign-style
> `logIndex` here.

### Verification

```bash
# Registry-side: confirm both packages resolve and the attestations exist
npm view @intentsolutions/refiner-core@0.1.0 version
npm view @intentsolutions/refiner@0.1.0 version
curl -s https://registry.npmjs.org/-/npm/v1/attestations/@intentsolutions%2frefiner-core@0.1.0
curl -s https://registry.npmjs.org/-/npm/v1/attestations/@intentsolutions%2frefiner@0.1.0

# Consumer-side: after installing, verify registry signatures + provenance
npm audit signatures
```

### Publish mechanism

Tag `refiner-v0.1.0` pushed to `main` triggered
`.github/workflows/publish-refiner.yml`, which pinned the checkout to the tag,
drift-guarded the tag against both `package.json` versions, ran the full gate,
then published **refiner-core first, then refiner** — each with
`pnpm publish --provenance` under the `@intentsolutions` scope using the existing
`NPM_TOKEN`. The post-publish "workspace: dep rewritten" guard passed (no literal
`workspace:` reached the published tarball).

- Workflow run: <https://github.com/jeremylongshore/j-rig-skill-binary-eval/actions/runs/27916699310>
  (GitHub Actions run id `27916699310`, all steps green)
