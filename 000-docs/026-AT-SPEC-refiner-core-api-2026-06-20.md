# `@j-rig/refiner-core` API Specification

**Date:** 2026-06-20
**Status:** NORMATIVE for the Phase A (wave 1) foundation surface
**Package:** `@j-rig/refiner-core` (private workspace package, version `0.1.0`, not published)
**Source of truth:** `packages/refiner-core/src/` (the JSDoc on each export is authoritative; this doc explains the surface, the diagrams, and the design rationale)

## Tri-link (AC-12 / DR-028 T3)

Per DR-028 T3 (`bd` is the canonical writer; GitHub and Plane are projections), every refiner-labeled artifact carries the three-layer cross-reference.

| Layer            | Identifier                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Bead (canonical) | `bd_000-projects-214c.5` (folds in `bd_000-projects-214c.6` D4 + `bd_000-projects-214c.7` D8)                        |
| GitHub issue     | [`jeremylongshore/j-rig-skill-binary-eval#81`](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/81) |
| Plane            | LAB module — Skill Refiner coordination (RC-IAJ)                                                                      |
| Coordination     | parent epic `bd_000-projects-214c`; product epic `bd_000-projects-3zol`; cross-links `bd_000-projects-rqwk` (iel)    |

---

## 1. Purpose and scope

`@j-rig/refiner-core` is the **pure core** of the Skill Refiner — the eval-guided
improvement loop that proposes safe, minimal `SKILL.md` edits and accepts a candidate
only on a strict, statistically-significant improvement. It is the second product in
the Intent Solutions agent-rig stack: **Test** (J-Rig Skill Binary Eval) → **Improve**
(Skill Refiner) → **Ship** (Rollout Gate).

Everything in this package is **I/O-free by construction**: no file handles, no model
clients, no network, no `process.exit`. Persistence, scoring, and the live model call
live in the adapter layer (`@j-rig/refiner`, wave 2+), behind the
[`RefinerStrategy`](#62-refinerstrategy) interface. The only non-pure input — wall-clock
time — is injected explicitly into [`bootstrap`](#52-bootstrap), so even time-dependent
output is deterministic given its inputs.

This surface is faithful to plan 027 § 4 (the Phase A API surface) plus the DR-028
(ISEDC Session 7) deltas:

- **P0-RATIFY-1** — `accept()` is a Pareto-dominant-on-behavioral predicate with an
  α = 0.05 significance threshold; multi-dimensional scores are never collapsed to a scalar.
- **P0-RATIFY-5** — every proposal carries a `refinerStrategyId` so a swappable mechanism
  never becomes an untraceable one.
- **P0-RATIFY-6** — every `EvalSet` carries `evalSetVersion` + `lineageParent` + `refreshDueAt`.

**Sources:**

- `intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md`
  (THE PLAN — v5 inline; § 4 API surface, § 6.5 diagram inventory)
- `intent-eval-lab/000-docs/028-AT-DECR-isedc-council-session-7-skill-refiner-plan-ratification-2026-05-27.md`
  (ISEDC Session 7 Decision Record)

### Import surface

```ts
import {
  // value types
  type SkillDoc,
  type ScoreDimension,
  type ScoreRecord,
  type EditOp,
  type EditProposal,
  type EvalItem,
  type EvalSet,
  type EvalSetSource,
  type RejectionReason,
  type AcceptResult,
  BEHAVIORAL_DIMENSION,
  DEFAULT_ALPHA,
  // content addressing
  sha256,
  canonicalJson,
  hashSkillDoc,
  hashValue,
  // pure operations
  applyEdit,
  makeSkillDoc,
  EditApplicationError,
  bootstrap,
  type BootstrapOptions,
  accept,
  isSignificantImprovement,
  isSignificantRegression,
  // swappable mechanism (AC-13)
  type RefinerStrategy,
  type RefinerModel,
  type ProposeContext,
  type ScoredRollout,
  NaiveInContextStrategy,
  NAIVE_IN_CONTEXT_STRATEGY_ID,
  SkillOptStyleStrategy,
  SKILL_OPT_STYLE_STRATEGY_ID,
  selectWorstRollouts,
  parseProposalResponse,
  extractJsonObject,
  OpParseError,
  MAX_OPS_PER_PROPOSAL,
} from "@j-rig/refiner-core";
```

---

## 2. Data flow (diagram D4)

The end-to-end flow from rollouts to a signed Evidence Bundle row. The boxed `REFINER-CORE`
region is what this package ships; the SkillVersion kernel entity, the promotion ladder, and
the Evidence Bundle emit are downstream (wave 2+ / gated). (Plan 027 § 6.5 D4; folds in
`bd_000-projects-214c.6`.)

```text
   ┌─────────────┐
   │  rollouts   │  (N runs of skill against held-out eval-set)
   │  (j-rig     │
   │   harness)  │
   └──────┬──────┘
          │  ScoreRecord[]
          ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                        REFINER-CORE  (pure)                 │
   │  ┌──────────┐    ┌──────────┐    ┌──────────┐               │
   │  │ score()  │───▶│ propose()│───▶│ accept() │               │
   │  └──────────┘    └──────────┘    └─────┬────┘               │
   │  multi-dim score   bounded edit ops    │ strict improvement │
   │  never collapsed   (add/del/replace)   │ on all dims?       │
   └─────────────────────────────────────────┼───────────────────┘
                                             │ yes               │ no
                                             ▼                   ▼
                              ┌──────────────────────┐  ┌──────────────────┐
                              │  new SkillVersion    │  │ rejected-edit    │
                              │  (content-addressed) │  │ buffer (kept,    │
                              │  parent = prior hash │  │ shown in AAR)    │
                              └──────────┬───────────┘  └──────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  promotion ladder    │
                              │  shadow → canary →   │
                              │  promote (HUMAN)     │
                              └──────────┬───────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Evidence Bundle row │
                              │  skill-refiner-pass  │
                              │  /v1  → Rekor (stg)  │
                              └──────────────────────┘
```

In this foundation, `score()` and `propose()` ship as **interfaces** — the
[`RefinerStrategy`](#62-refinerstrategy) contract — with the live model adapter deferred to
`@j-rig/refiner`. `accept()` and `applyEdit()` are the concrete pure functions; `bootstrap()`
synthesizes the held-out eval set that the rollouts run against.

---

## 3. Library architecture (diagram D8)

`@j-rig/refiner` is a thin orchestrator + CLI binding that depends on `@j-rig/refiner-core`.
All adapters (model, fs, binary-eval shell-out, emit, cost meter) live in `@j-rig/refiner`,
**never** in core. (Plan 027 § 6.5 D8; folds in `bd_000-projects-214c.7`.)

```text
   ┌──────────────────────────────────────────────────────────────────────┐
   │                       @j-rig/refiner  (npm)                          │
   │   thin orchestrator + CLI binding; depends on refiner-core           │
   └──────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                   @j-rig/refiner-core  (npm)                         │
   │   PURE value-oriented library — zero adapters, zero side effects     │
   │                                                                       │
   │   ┌────────────────┐  ┌────────────────┐  ┌────────────────┐         │
   │   │ score()        │  │ propose()      │  │ accept()       │         │
   │   │ (interface)    │  │ (interface)    │  │ (PURE FN)      │         │
   │   └────────────────┘  └────────────────┘  └────────────────┘         │
   │                                                                       │
   │   ┌────────────────┐  ┌────────────────┐  ┌────────────────┐         │
   │   │ apply()        │  │ bootstrap()    │  │ value types    │         │
   │   │ (PURE FN)      │  │ (synthesis     │  │ (SkillDocHash, │         │
   │   │                │  │  helper)       │  │  ScoreRecord,  │         │
   │   │                │  │                │  │  EditProposal) │         │
   │   └────────────────┘  └────────────────┘  └────────────────┘         │
   │   No fs. No network. No process.exit. Deterministic given inputs.    │
   │   ≥80% coverage gate. Mutation testing optional.                     │
   └──────────────────────────────────────────────────────────────────────┘

   ADAPTERS (live in @j-rig/refiner, NOT core):
     • model adapter (Anthropic SDK / mock)
     • fs adapter   (read SKILL.md, write SkillVersion)
     • binary-eval adapter (shell-out to j-rig CLI)
     • emit adapter (audit-harness shell-out → Evidence Bundle + Rekor)
     • cost meter   (tiered routing budget)

   Swap rule: when frontier-native refinement arrives, replace
   propose() impl in refiner with a thin shim; keep adapters,
   keep tests, keep the acceptance gate. THAT is the durable contribution.
```

**The seam is the [`RefinerStrategy`](#62-refinerstrategy) interface.** The two `(interface)`
boxes in core (`score()` / `propose()`) are exactly that declare-only contract: core ships the
typed seam, never an adapter. Everything below the seam line — the model client, the filesystem,
the binary-eval shell-out, the emit adapter, the cost meter — lives in `@j-rig/refiner` and is
injected through that interface (the live model arrives as a `RefinerModel` collaborator, § 6.1).
Core stays pure precisely because the only thing crossing the core↔adapter boundary is the
`RefinerStrategy` contract; nothing I/O-bearing leaks upward.

**The swap rule is the durable contribution (AC-7 bitter-lesson hedge).** The MECHANISM
(`propose()`, behind the `RefinerStrategy` seam) is swappable; the GATE (`accept()`, a pure
function on the core side) is not. When a better refinement mechanism arrives — including a
frontier-native one — you supply a new `RefinerStrategy` implementation in the adapter package
and keep the adapters, the tests, and the acceptance gate on the core side untouched.

---

## 4. Value types

The content-addressable domain. All types are `readonly` value objects — the Refiner never
mutates in place (AC-2 append-only discipline). Source: `packages/refiner-core/src/types.ts`.

### 4.1 Content-address aliases

| Type               | Definition           | Meaning                                                             |
| ------------------ | -------------------- | ------------------------------------------------------------------ |
| `Sha256`           | `string`             | A lowercase-hex SHA-256 string (64 chars). A content address.      |
| `SkillDocHash`     | `Sha256`             | Content address of a `SKILL.md` document.                          |
| `EvalSetHash`      | `Sha256`             | Content address of an eval set.                                    |
| `RefinerStrategyId`| `string`             | Stable identifier of a `RefinerStrategy` reference impl (P0-RATIFY-5). |

### 4.2 `SkillDoc`

A `SKILL.md` document as a pure value. [`applyEdit`](#51-applyedit) returns a **new**
`SkillDoc` with a new `hash`; it never mutates the input.

| Field     | Type           | Notes                                                          |
| --------- | -------------- | -------------------------------------------------------------- |
| `skillId` | `string`       | kebab-slug skill identifier, e.g. `"validate-skillmd"`.        |
| `text`    | `string`       | Full `SKILL.md` text (frontmatter + body).                     |
| `hash`    | `SkillDocHash` | Content address of `text`; compute via [`hashSkillDoc`](#54-content-addressing). |

### 4.3 `ScoreDimension` and `ScoreRecord`

A `ScoreRecord` is a multi-dimensional measurement of one skill version against one eval set.
Scores are **never** collapsed to a scalar (AC-3, Goodhart-resistant). Higher is always better
on every dimension. `behavioral` is the kernel-pinned Pareto-dominant dimension and is REQUIRED;
all other numeric dimensions are "named dims" that must not regress.

`ScoreDimension`:

| Field      | Type     | Notes                                                                               |
| ---------- | -------- | ----------------------------------------------------------------------------------- |
| `value`    | `number` | Point estimate (higher is better).                                                  |
| `variance` | `number` | Sample variance of the estimate; used for the α-significance test. Deterministic dims report `0`. |
| `n`        | `number` | Number of samples (eval-set rollouts) behind the estimate. `>= 1`.                  |

`ScoreRecord`:

| Field        | Type                                        | Notes                                                |
| ------------ | ------------------------------------------- | ---------------------------------------------------- |
| `skill`      | `SkillDocHash`                              | Which skill version was scored.                      |
| `evalSet`    | `EvalSetHash`                               | Which eval set it was scored against.                |
| `behavioral` | `ScoreDimension`                            | Pinned Pareto-dominant dimension (REQUIRED).         |
| `dimensions` | `Readonly<Record<string, ScoreDimension>>`  | All scored dimensions, keyed by name; MUST include `behavioral`. |

The pinned dimension key is exported as the constant `BEHAVIORAL_DIMENSION = "behavioral"`.
The full dimension set is pinned in the `@intentsolutions/core` SkillVersion schema (CISO
determinism binding, DR-028 P0-RATIFY-1); this package pins only the behavioral key the
predicate is anchored on.

### 4.4 Edit ops and `EditProposal`

A bounded edit op is a SkillOpt-style add / delete / replace, each anchored to an **exact**
substring of the doc.

| Op type     | Discriminant       | Fields                                                            |
| ----------- | ------------------ | ---------------------------------------------------------------- |
| `AddOp`     | `kind: "add"`      | `after` (exact anchor substring), `content` (text inserted after it). |
| `DeleteOp`  | `kind: "delete"`   | `target` (exact substring to remove).                            |
| `ReplaceOp` | `kind: "replace"`  | `target` (exact substring), `content` (replacement).             |

`EditOp` is the discriminated union `AddOp | DeleteOp | ReplaceOp`.

`EditProposal` — a proposed bounded edit emitted by a `RefinerStrategy`. Content-addressable
via its `parent` hash + `ops`. Carries `refinerStrategyId` so the proposal is mechanism-traceable
(DR-028 P0-RATIFY-5 / AC-13).

| Field               | Type                | Notes                                                      |
| ------------------- | ------------------- | ---------------------------------------------------------- |
| `parent`            | `SkillDocHash`      | Hash of the skill doc this proposal edits.                 |
| `ops`               | `readonly EditOp[]` | The bounded edit ops (≤ `MAX_OPS_PER_PROPOSAL` = 8).       |
| `refinerModel`      | `string`            | Model identifier that produced the proposal, e.g. `"claude-sonnet"`. |
| `refinerStrategyId` | `RefinerStrategyId` | Which strategy produced this proposal (signed downstream). |
| `rationale`         | `string`            | Verbatim natural-language rationale from the strategy.     |

### 4.5 `EvalItem` and `EvalSet`

`EvalItem` — a single graded item in an eval set.

| Field         | Type     | Notes                                                          |
| ------------- | -------- | -------------------------------------------------------------- |
| `id`          | `string` | Stable item identifier.                                        |
| `prompt`      | `string` | The probe prompt.                                              |
| `expectation` | `string?`| Optional expected-behavior note (golden trace / acceptance criterion). |

`EvalSetSource` is `"synthetic" | "harvested" | "golden" | "hybrid"` (plan 027 § 4 / AC-6).
This foundation ships the `"synthetic"` source via [`bootstrap`](#52-bootstrap); harvested and
golden ingestion are I/O adapters (wave 2+).

`EvalSet` — a held-out eval set with versioning + lineage (DR-028 P0-RATIFY-6).

| Field            | Type                   | Notes                                                                     |
| ---------------- | ---------------------- | ------------------------------------------------------------------------- |
| `hash`           | `EvalSetHash`          | Content address of the set's content-bearing fields.                      |
| `skillId`        | `string`               | Skill the set was bootstrapped from.                                      |
| `source`         | `EvalSetSource`        | Provenance of the items.                                                  |
| `items`          | `readonly EvalItem[]`  | The graded items (order is meaningful).                                   |
| `evalSetVersion` | `string`               | Semver of the eval set, e.g. `"1.0.0"`.                                   |
| `lineageParent`  | `EvalSetHash \| null`  | Hash of the prior set in the lineage, or `null` for the root.             |
| `refreshDueAt`   | `string \| null`       | rfc3339 refresh-due timestamp (90 days default), or `null` in `--quick` mode (VP DevRel binding). |

### 4.6 `RejectionReason` and `AcceptResult`

`RejectionReason` is the machine-readable tag on a rejected edit, surfaced in the rejected-edit
buffer (shown in the Evidence Report AAR):

| Reason                       | Meaning                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `no-behavioral-improvement`  | Candidate did not strictly (significantly) improve the behavioral dimension.  |
| `regressed-named-dimension`  | Behavioral flat **and** a non-behavioral named dimension regressed.           |
| `pareto-incomparable`        | Behavioral improved **but** another named dim regressed — the DR-028 tie-break (neither version dominates). |
| `incomparable-records`       | The two records were scored against different eval sets.                      |

`AcceptResult` is the discriminated union:

```ts
type AcceptResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: RejectionReason };
```

`DEFAULT_ALPHA = 0.05` is the exported default significance level for the acceptance gate
(DR-028 P0-RATIFY-1).

---

## 5. Pure functions

### 5.1 `applyEdit`

```ts
function applyEdit(doc: SkillDoc, proposal: EditProposal): SkillDoc;
function makeSkillDoc(skillId: string, text: string): SkillDoc;
class EditApplicationError extends Error { readonly op: EditOp; }
```

Applies a bounded `EditProposal` to a `SkillDoc`, returning a **new** `SkillDoc` with a freshly
computed hash (append-only, AC-2 — never mutates the input). Each op anchors to an **exact**
substring; an anchor that is missing **or** ambiguous (more than one occurrence) fails loudly
with `EditApplicationError` — silent partial application would corrupt the audit trail.

- `throws EditApplicationError` if `proposal.parent !== doc.hash` (you cannot apply an edit
  proposed against a different version), or if any op's anchor/target is empty, missing, or
  ambiguous.
- `makeSkillDoc(skillId, text)` is the convenience constructor that builds a `SkillDoc` value
  (computing the hash) from raw text.

### 5.2 `bootstrap`

```ts
function bootstrap(doc: SkillDoc, opts?: BootstrapOptions): EvalSet;

interface BootstrapOptions {
  readonly evalSetVersion?: string;      // default "1.0.0"
  readonly lineageParent?: string | null; // default null (root)
  readonly quick?: boolean;               // default false
  readonly now?: string;                  // rfc3339; injected for determinism
}
```

Synthesizes a **deterministic** synthetic `EvalSet` from a skill doc (AC-6 — eval-set bootstrap
is non-optional; every skill the Refiner touches needs a held-out set). Given identical
`doc.text` + `opts`, it always produces the identical `EvalSet`, including its hash.

The clock is the only non-pure input and it is injected via `opts.now` (rfc3339), which keeps
`bootstrap` a pure function. The produced set carries `evalSetVersion` + `lineageParent` +
`refreshDueAt` (DR-028 P0-RATIFY-6); `refreshDueAt` is computed as `now + 90 days` unless
`quick` is set, in which case it is `null` (VP DevRel binding for casual contributors).

The synthetic probe extractor is intentionally simple + deterministic — non-empty,
non-frontmatter, non-heading body lines of length ≥ 12 become probes. A richer coverage
analysis lands in a later wave; this gives a held-out set you can score against today.

`throws RangeError` if `opts.now` is supplied but is not a valid rfc3339 timestamp.

### 5.3 `accept` — the acceptance gate

```ts
function accept(
  baseline: ScoreRecord,
  candidate: ScoreRecord,
  alpha?: number, // default DEFAULT_ALPHA = 0.05
): AcceptResult;

function isSignificantImprovement(
  candidate: ScoreDimension,
  baseline: ScoreDimension,
  alpha?: number,
): boolean;

function isSignificantRegression(
  candidate: ScoreDimension,
  baseline: ScoreDimension,
  alpha?: number,
): boolean;
```

**The heart of the package** — the durable contribution (AC-7). A pure predicate implementing
DR-028 P0-RATIFY-1 exactly. `accept()` returns `{ accepted: true }` **only** when the candidate
Pareto-dominates the baseline:

1. **Strict, significant improvement** on the kernel-pinned `behavioral` dimension — a one-sided
   significance test at α (default 0.05) over each dimension's variance + sample count.
2. **Non-regression** on every other named dimension — a statistically *insignificant* dip is
   tolerated; a *significant* drop is a regression. A candidate that stops measuring a baseline
   dimension is treated as a regression (the candidate dropped a measured guarantee).

The decision table:

| Behavioral improved? | A named dim regressed? | Result                                  |
| -------------------- | ---------------------- | --------------------------------------- |
| different eval sets  | —                      | reject `incomparable-records`           |
| yes                  | no                     | `{ accepted: true }`                    |
| yes                  | yes                    | reject `pareto-incomparable` (DR-028 tie-break) |
| no                   | yes                    | reject `regressed-named-dimension`      |
| no                   | no                     | reject `no-behavioral-improvement`      |

The significance test is a two-sample z-test on the difference of means using the variance +
sample count carried on each `ScoreDimension`. A deterministic dimension (variance 0) reduces
to an exact `>` / `<` comparison, which is the correct limiting behavior. The implementation
maps common α levels to exact z critical values and falls back to Acklam's inverse-normal-CDF
approximation otherwise — no external stats dependency.

`isSignificantImprovement` and `isSignificantRegression` are the exported per-dimension building
blocks `accept` composes.

### 5.4 Content addressing

```ts
function sha256(text: string): string;             // lowercase-hex SHA-256 of a UTF-8 string
function canonicalJson(value: unknown): string;    // key-sorted JSON; arrays preserve order
function hashSkillDoc(text: string): string;        // content address of a SKILL.md
function hashValue(value: unknown): string;         // content address of any value via canonical JSON
```

Deterministic SHA-256 over canonical-JSON / UTF-8 text using the Node `node:crypto` builtin — no
external dependency, no I/O. `canonicalJson` sorts object keys recursively so structurally-equal
values hash identically regardless of key insertion order; arrays preserve order (order is
meaningful for edit ops + eval items). This is the basis for the append-only content-addressed
store (AC-2) and for comparing whether two `ScoreRecord`s refer to the same skill.

---

## 6. The swappable mechanism (AC-13)

The Refiner mechanism is swappable behind a typed interface; the acceptance gate is the durable
piece (the AC-7 bitter-lesson hedge). To keep strategies unit-testable as pure code, the model
call is **injected** as a `RefinerModel` rather than baked in. Source:
`packages/refiner-core/src/strategies/`.

### 6.1 Strategy collaborators

```ts
interface RefinerModel {
  readonly id: string;                          // stable model id, recorded on the proposal
  complete(prompt: string): Promise<string>;    // a single completion: prompt in, text out
}

interface ScoredRollout {
  readonly score: ScoreRecord;                  // the multi-dim score for this rollout
  readonly evalItemId: string;                  // which eval item this rollout exercised
  readonly transcript: string;                  // verbatim model output (input to propose reasoning)
}

interface ProposeContext {
  readonly doc: SkillDoc;
  readonly rollouts: readonly ScoredRollout[];
  readonly model: RefinerModel;
}
```

A real `RefinerModel` adapter wraps the Anthropic SDK (wave 2+); tests pass a deterministic stub.

### 6.2 `RefinerStrategy`

```ts
interface RefinerStrategy {
  readonly id: RefinerStrategyId;               // stable, signable identifier
  readonly description: string;                 // human-readable; surfaced in the Evidence Report
  propose(ctx: ProposeContext): Promise<EditProposal>;
}
```

The **declare-only** swappable mechanism. An implementation embodies one `propose()` strategy.
Per the conformance suite, an implementation MUST return a proposal whose `parent === ctx.doc.hash`
and whose `refinerStrategyId === this.id`. Per the CISO binding, every strategy has a stable `id`,
recorded on the `EditProposal` (`refinerStrategyId`) and signed in the predicate payload — so a
swappable mechanism never becomes an untraceable one.

### 6.3 Reference implementation — `NaiveInContextStrategy`

```ts
class NaiveInContextStrategy implements RefinerStrategy { /* ... */ }
const NAIVE_IN_CONTEXT_STRATEGY_ID = "naive-in-context/v1";
```

The **null-hypothesis baseline** (DR-028 P0-RATIFY-3/5). Single pass: drop the whole skill doc
into the model context, ask for a minimal bounded improvement, take whatever bounded ops come
back. No scored-rollout analysis, no targeted prompting, no iteration. Deliberately the dumbest
thing that could work — it doubles as the Phase A.0 baseline the proposed mechanism must beat by
> 70% of projected lift, or Phase B descopes.

### 6.4 Reference implementation — `SkillOptStyleStrategy`

```ts
class SkillOptStyleStrategy implements RefinerStrategy { /* ... */ }
const SKILL_OPT_STYLE_STRATEGY_ID = "skill-opt-style/v1";

function selectWorstRollouts(rollouts: readonly ScoredRollout[], k?: number): ScoredRollout[];
```

The SkillOpt-style mechanism (after arXiv 2605.23904): rather than dropping the whole doc in
blind, it locates the **lowest-scoring** rollouts (the "gradient signal"), feeds the model the
doc plus those failing transcripts, and asks for bounded edits targeted at the observed failures.
This is the text-space SGD analog — edits are informed by where the skill empirically
underperformed. `selectWorstRollouts` sorts rollouts ascending by behavioral score and returns
the `k` weakest (default 3).

### 6.5 Op parsing + bounds enforcement

```ts
function parseProposalResponse(completion: string): ParsedProposal;
function extractJsonObject(text: string): string;
class OpParseError extends Error {}
const MAX_OPS_PER_PROPOSAL = 8;

interface ParsedProposal {
  readonly rationale: string;
  readonly ops: readonly EditOp[];
}
```

Shared, pure op-parsing both reference strategies use, so the op grammar is validated identically
across mechanisms. `extractJsonObject` extracts the first balanced JSON object from a completion
(models often wrap JSON in prose or fences). `parseProposalResponse` validates the JSON against a
Zod discriminated-union schema (add / delete / replace with non-empty anchors) and **truncates**
to at most `MAX_OPS_PER_PROPOSAL` = 8 ops (excess is truncated, not an error — keeping the
mechanism robust to over-eager models). It `throws OpParseError` if no parseable, schema-valid
JSON is present.

---

## 7. Deferred / still-gated (NOT in this foundation)

Per the package README and the Skill Refiner plan, these are out of scope for the wave-1
foundation:

- `score()` / `propose()` **I/O adapters** — the j-rig shell-out scorer and the Anthropic SDK
  proposer. (The `propose()` *contract* ships as `RefinerStrategy`; the live model adapter is wave 2+.)
- The content-addressed **on-disk store** + event log + best-pointer + the CLI (`j-rig refine …`).
- The **`SkillVersion` kernel entity** (14th canonical entity) — a signed one-way-door per
  DR-028 T1; lives in `@intentsolutions/core`, designed separately.
- The **`skill-refiner-pass/v1` predicate URI** — needs a separate Class-1 ADR per the SAK
  charter; not minted here.
- The **Claude Code plugin + 3-layer hooks** (sinker / line / hook).
- **Publishing** (`@j-rig/refiner-core@0.1.0` release ceremony).

---

## 8. Build and test

```bash
pnpm --filter @j-rig/refiner-core run build
pnpm --filter @j-rig/refiner-core run test
```

The package targets ≥ 80% coverage (D8); mutation testing is optional. Every export above has a
co-located `*.test.ts` in `packages/refiner-core/src/`.

---

## 9. References

- `intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md`
  — THE PLAN (§ 4 API surface, § 6.5 D4 + D8 diagrams).
- `intent-eval-lab/000-docs/028-AT-DECR-isedc-council-session-7-skill-refiner-plan-ratification-2026-05-27.md`
  — ISEDC Session 7 Decision Record (P0-RATIFY-1, -3, -5, -6; T1, T3 bindings).
- `packages/refiner-core/src/` — the authoritative source; each export's JSDoc is normative.
- `packages/refiner-core/README.md` — the foundation overview.
