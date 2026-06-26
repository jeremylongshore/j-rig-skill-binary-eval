# @intentsolutions/refiner-core

Foundation (Phase A, wave 1) of the **Skill Refiner** — the eval-guided
improvement loop that proposes safe, minimal `SKILL.md` edits and accepts only
on strict score improvement. Second product in the Intent Solutions agent-rig
stack: **Test** (J-Rig Skill Binary Eval) → **Improve** (Skill Refiner) → **Ship**
(Rollout Gate).

Published as `@intentsolutions/refiner-core@0.1.0` to npm.

Plan: `intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md`
Ratification: `intent-eval-lab/000-docs/028-AT-DECR-isedc-council-session-7-...-2026-05-27.md`

## What this foundation ships

Everything here is **pure** — no file I/O, no network, no model calls baked in.
The model call is *injected* into a strategy so the mechanism stays unit-testable.

| Surface | Export | Role |
| --- | --- | --- |
| Value types | `SkillDoc`, `ScoreRecord`, `ScoreDimension`, `EditProposal`, `EditOp`, `EvalSet`, `EvalItem`, `AcceptResult`, `RejectionReason` | The content-addressable domain (plan § 4 + DR-028 deltas) |
| Content addressing | `sha256`, `canonicalJson`, `hashSkillDoc`, `hashValue` | Deterministic hashing for the append-only store |
| `applyEdit` | pure transform | Apply a bounded `EditProposal` → a new `SkillDoc` (append-only; never mutates) |
| `bootstrap` | pure (clock injected) | Synthesize a deterministic synthetic `EvalSet` from a `SKILL.md`, with `eval_set_version` + `lineage_parent` + `refresh_due_at` (DR-028 P0-RATIFY-6) and a `--quick` mode |
| **`accept`** | **pure predicate** | **The heart.** DR-028 P0-RATIFY-1 acceptance gate (below) |
| `RefinerStrategy` | interface | AC-13 swappable mechanism behind a typed interface |
| `NaiveInContextStrategy` | reference impl | Single-pass whole-doc proposal — also the Phase A.0 null-hypothesis baseline |
| `SkillOptStyleStrategy` | reference impl | Worst-rollout-targeted bounded edits (text-space SGD analog, after SkillOpt) |
| **`computeSliceUtility`** | **pure (scorer injected)** | **COMPUTED per-block utility** via Leave-One-Block-Out causal attribution (below). `sliceIntoBlocks` + `gateEvalSet` are the supporting seams. |

## The acceptance gate (DR-028 P0-RATIFY-1)

`accept(baseline, candidate, alpha = 0.05)` returns `{ accepted: true }` **only**
when the candidate Pareto-dominates the baseline:

1. **Strict, significant improvement** on the kernel-pinned `behavioral` dimension
   (a one-sided significance test at α = 0.05 over each dimension's variance + sample count).
2. **Non-regression** on every other named dimension (a statistically *insignificant*
   dip is tolerated; a *significant* drop is a regression). A candidate that stops
   measuring a baseline dimension is treated as a regression.

Rejections are reason-tagged for the audit buffer (shown in the Evidence Report):

| Reason | When |
| --- | --- |
| `no-behavioral-improvement` | behavioral did not significantly improve |
| `pareto-incomparable` | behavioral improved **but** another named dim regressed — the DR-028 tie-break (neither version dominates) |
| `regressed-named-dimension` | behavioral flat **and** a named dim regressed |
| `incomparable-records` | the two records were scored against different eval sets |

## Per-block slice utility — COMPUTED, not a constant (epic intent-eval-lab#206)

`computeSliceUtility(...)` attributes a utility to each block of a `SKILL.md`
via **Leave-One-Block-Out (LOBO)** causal attribution. A block's utility is the
**measured counterfactual effect of removing it** — the signed change in the
behavioral eval score when that block is ablated, judged at the **same α=0.05
bar** `accept()` uses.

This is the deliberate **inverse** of the meta_skill anti-pattern (a const table
keyed on block type, e.g. `Policy = 0.95` by fiat). Here a block's *type* never
sets its utility; its utility is the demonstrated effect of its presence:

| Class | Meaning |
| --- | --- |
| `load-bearing` | ablation **significantly regressed** behavioral — the block carries weight |
| `harmful` | ablation **significantly improved** behavioral — a cut candidate |
| `inert` | no significant move, **adequate** sample power |
| `inconclusive` | no significant move, **underpowered** — a low-power null is *not* a computed zero |
| `schema-required` | ablation made the doc schema-invalid (kernel `SkillFrontmatterSchema`) → `utility: null`, **never scored** |

Per block: `sliceIntoBlocks(doc)` → unique `DeleteOp` anchors → `applyEdit` →
schema-check the ablated variant **first** → score the survivors against the
**same frozen eval set** (injected `BlockScorer`) → classify the signed delta.

The output is a **per-block vector** (`SliceUtilityReport.blocks`) — there is
**no skill-level aggregate / "usefulness %" field** by construction (the C3
no-rolled-score rule; the `NO_SKILL_LEVEL_AGGREGATE` marker documents it).

Two modes: `mode: "full"` (ablate every block, K+1 scorer calls) and
`mode: "capped"` + `maxAblations` (weakest-first order under a budget — block
*type* is admissible only as **ablation order**, never as the score). Blocks not
reached are reported in `skipped`.

**Anti-gaming (Rule 3):** the eval set is gated first. `synthetic`/`golden` sets
pass by construction; `harvested`/`hybrid` sets need an explicit
`verifiedEvalSet: true`; any refresh-due set (`isRefreshDue`) is `ungated`. An
ungated set **refuses** by default (empty `blocks`, all ids in `skipped`) unless
`allowUngated: true`.

**Stays pure refiner-core (Rule 4):** `BlockUtility` is **not** a kernel entity
and this module emits **no** signed bundle row. Any kernel routing is a separate,
gated bead with its own DR. LOBO is a **first-order** approximation (it misses
two-block interaction effects — true Shapley is `2^K`, a wave-2 opt-in).

```ts
import { computeSliceUtility, type BlockScorer } from "@intentsolutions/refiner-core";

const report = computeSliceUtility({ doc, evalSet, scorer });
for (const b of report.blocks) {
  console.log(b.blockId, b.class, b.utility, `rank=${b.utilityRank}`);
}
```

## Deferred / still-gated (NOT in this foundation)

- `score()` / `propose()` **I/O adapters** — the j-rig shell-out scorer and the
  Anthropic SDK proposer. (The `propose()` *contract* ships as `RefinerStrategy`;
  the live model adapter is wave 2+.)
- The content-addressed **on-disk store** + event log + best-pointer + the CLI
  (`j-rig refine …`).
- The **`SkillVersion` kernel entity** (14th canonical entity) — a signed
  one-way-door per DR-028 T1; lives in `@intentsolutions/core`, designed separately.
- The **`skill-refiner-pass/v1` predicate URI** — needs a separate Class-1 ADR per
  the SAK charter; not minted here.
- The **Claude Code plugin + 3-layer hooks** (sinker/line/hook).
- **Publishing** (`@intentsolutions/refiner-core@0.1.0` release ceremony).

## Build & test

```bash
pnpm --filter @intentsolutions/refiner-core run build
pnpm --filter @intentsolutions/refiner-core run test
```
