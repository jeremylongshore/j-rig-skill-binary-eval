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
