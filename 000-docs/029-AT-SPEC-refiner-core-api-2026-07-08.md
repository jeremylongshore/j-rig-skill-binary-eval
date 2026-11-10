<!-- BEGIN BD-SYNC:cross-ref:v1 -->

Beads: `bd_000-projects-pu35.3`
GitHub: `jeremylongshore/j-rig-skill-binary-eval#274`
Projection-SHA256: cc29f093344cc2fce77c74eac2cfcf44e492453e47867ca425ca266ddd2ec96c

<!-- END BD-SYNC:cross-ref:v1 -->

# `@intentsolutions/refiner-core` Public API Specification (v0.2.0)

| Beads | `bd_000-projects-214c.5`, `bd_000-projects-pu35.3`, `bd_000-projects-214c.14`, `bd_000-projects-214c.13`, `bd_000-projects-214c.16`, `bd_000-projects-214c.15`, `bd_000-projects-214c.17`, `bd_000-projects-214c.18.1` |
| GitHub | `jeremylongshore/j-rig-skill-binary-eval#81`, `jeremylongshore/j-rig-skill-binary-eval#274`, `jeremylongshore/j-rig-skill-binary-eval#393`, `jeremylongshore/j-rig-skill-binary-eval#394`, `jeremylongshore/j-rig-skill-binary-eval#398`, `jeremylongshore/j-rig-skill-binary-eval#397`, `jeremylongshore/j-rig-skill-binary-eval#401`, `jeremylongshore/j-rig-skill-binary-eval#404` |

**Date:** 2026-07-08
**Status:** NORMATIVE for the `@intentsolutions/refiner-core@0.2.0` published surface
**Package:** `@intentsolutions/refiner-core` (published to npm, version `0.2.0`)
**Source of truth:** `packages/refiner-core/src/` — the JSDoc on each export is authoritative; this doc explains the surface, the accept-predicate semantics, and the swappable-mechanism contract.
**Supersedes (as the current surface):** `000-docs/026-AT-SPEC-refiner-core-api-2026-06-20.md`, which documents the wave-1 `0.1.0` foundation. This doc covers the grown `0.2.0` surface (the adoption signal, slice-utility, the 4-quadrant `decide()`, eval-set quality metrics, the kernel/judge-version contracts, and the schema-validator seam) added since. Where the two agree, 026's rationale still applies; where they differ, this doc + the source JSDoc win.

## Tri-link (AC-12 / DR-028 T3)

Per DR-028 T3 (`bd` is the canonical writer; GitHub and Plane are projections), this refiner-labeled artifact carries the three-layer cross-reference.

| Layer            | Identifier                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Bead (canonical) | `bd_000-projects-214c.5` (refiner-core public-API documentation); AC-12 backfill `bd_000-projects-pu35.3` |
| GitHub issue     | [`jeremylongshore/j-rig-skill-binary-eval#81`](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/81); backfill [`#274`](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/274) |
| Plane            | LAB module — Skill Refiner coordination (RC-IAJ)                                                                     |
| Coordination     | parent epic `bd_000-projects-214c`; product epic `bd_000-projects-3zol`; Plane backfill `LAB-123`                  |

---

## 1. Purpose and scope

`@intentsolutions/refiner-core` is the **pure core** of the Skill Refiner — the eval-guided improvement loop that proposes safe, minimal `SKILL.md` edits and accepts a candidate only on a strict, statistically-significant improvement. It is the second product in the Intent Solutions agent-rig stack: **Test** (J-Rig Skill Binary Eval) → **Improve** (Skill Refiner) → **Ship** (Rollout Gate).

Everything in this package is **I/O-free by construction**: no file handles, no model clients, no network, no `process.exit`. Persistence, scoring, and the live model call live in the adapter layer (`@intentsolutions/refiner`), behind the [`RefinerStrategy`](#81-collaborators--refinerstrategy) interface. The only non-pure input — wall-clock time — is injected explicitly (into `bootstrap`, `computeAdoptionVerdict`, and the version-contract triggers), so even time-dependent output is deterministic given its inputs.

The surface is faithful to plan 027 § 4 + the DR-028 (Session 7) deltas, and has grown per epic `intent-eval-lab#206` / ISEDC DR-103 (the skill-scoring layer) while keeping the same purity discipline.

**Sources:**

- `intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md` (THE PLAN — § 4 API surface)
- `intent-eval-lab/000-docs/028-AT-DECR-isedc-council-session-7-skill-refiner-plan-ratification-2026-05-27.md` (DR-028)
- `intent-eval-lab/000-docs/103-*` (DR-103 — the deterministic adoption signal; bandit rejection)

---

## 2. Import surface

```ts
import {
  // ── value types ──
  type Sha256, type SkillDocHash, type EvalSetHash, type RefinerStrategyId,
  type SkillDoc, type ScoreDimension, type ScoreRecord,
  type AddOp, type DeleteOp, type ReplaceOp, type EditOp, type EditProposal,
  type EvalItem, type EvalSetSource, type EvalSet, type EvalSetRef,
  type RejectionReason, type AcceptResult,
  BEHAVIORAL_DIMENSION, DEFAULT_ALPHA,

  // ── eval-set schema + validation + ref derivation ──
  EvalSetSchema, EvalItemSchema, EvalSetRefSchema, EvalSetSourceSchema,
  validateEvalSet, deriveEvalSetRef, isRefreshDue,
  UUIDV7_REGEX, SHA256_REGEX, SHA256_PREFIXED_REGEX,

  // ── content addressing ──
  sha256, canonicalJson, hashSkillDoc, hashValue,

  // ── pure operations ──
  applyEdit, makeSkillDoc, EditApplicationError,
  bootstrap, bootstrapFromItems, type BootstrapOptions,
  accept, isSignificantImprovement, isSignificantRegression,

  // ── cost meter ──
  type ModelUsage, type AttemptRecord, type BudgetConfig, type CostMeter,
  type QuarantineRecord, type BudgetDecision, type AcceptRollup,
  totalTokens, createCostMeter,

  // ── swappable mechanism (AC-13) ──
  type RefinerStrategy, type RefinerModel, type ProposeContext, type ScoredRollout,
  NaiveInContextStrategy, NAIVE_IN_CONTEXT_STRATEGY_ID,
  SkillOptStyleStrategy, SKILL_OPT_STYLE_STRATEGY_ID,
  selectWorstRollouts, parseProposalResponse, extractJsonObject,
  OpParseError, MAX_OPS_PER_PROPOSAL,

  // ── kernel- / judge-version contracts ──
  CONSUMED_KERNEL_VERSION, isBaselineSupersededByKernel, makeSupersededBaselineRecord,
  CONSUMED_JUDGE_VERSION, isBaselineSupersededByJudge, makeVNextBaselineTrigger,

  // ── 4-quadrant schema-validity × judge-verdict decision ──
  decide, kernelSkillFrontmatterValidator, extractFrontmatter, parseFrontmatterYaml,

  // ── eval-set quality metrics ──
  coverage, leakage, calibration, adversarialPassRate, evaluateEvalSet,

  // ── slice-utility (LOBO causal attribution) ──
  gateEvalSet, sliceIntoBlocks, computeSliceUtility, NO_SKILL_LEVEL_AGGREGATE,

  // ── deterministic time-decay adoption signal ──
  computeAdoptionVerdict, toAdoptionObservations,
  PROVISIONAL_ADOPTION_THRESHOLDS, NO_ROLLED_ADOPTION_SCORE,
} from "@intentsolutions/refiner-core";
```

The authoritative export list is `packages/refiner-core/src/index.ts`.

---

## 3. Value types

The content-addressable domain. All types are `readonly` value objects — the Refiner never mutates in place (AC-2 append-only discipline). Source: `packages/refiner-core/src/types.ts`.

### 3.1 Content-address aliases

| Type                | Definition | Meaning                                                                |
| ------------------- | ---------- | --------------------------------------------------------------------- |
| `Sha256`            | `string`   | A lowercase-hex SHA-256 string (64 chars). A content address.         |
| `SkillDocHash`      | `Sha256`   | Content address of a `SKILL.md` document.                             |
| `EvalSetHash`       | `Sha256`   | Content address of an eval set.                                       |
| `RefinerStrategyId` | `string`   | Stable identifier of a `RefinerStrategy` reference impl (P0-RATIFY-5). |

### 3.2 `SkillDoc`

A `SKILL.md` document as a pure value. `applyEdit` returns a **new** `SkillDoc` with a new `hash`; it never mutates the input.

| Field     | Type           | Notes                                                     |
| --------- | -------------- | -------------------------------------------------------- |
| `skillId` | `string`       | kebab-slug skill identifier, e.g. `"validate-skillmd"`.  |
| `text`    | `string`       | Full `SKILL.md` text (frontmatter + body).               |
| `hash`    | `SkillDocHash` | Content address of `text`; compute via `hashSkillDoc`.   |

### 3.3 `ScoreDimension` and `ScoreRecord`

A `ScoreRecord` is a multi-dimensional measurement of one skill version against one eval set. Scores are **never** collapsed to a scalar (AC-3, Goodhart-resistant). Higher is always better on every dimension. `behavioral` is the kernel-pinned Pareto-dominant dimension and is REQUIRED; every other numeric dimension is a "named dim" that must not regress.

`ScoreDimension`:

| Field      | Type     | Notes                                                                            |
| ---------- | -------- | ------------------------------------------------------------------------------- |
| `value`    | `number` | Point estimate (higher is better).                                              |
| `variance` | `number` | Sample variance of the estimate; used for the α-significance test. Deterministic dims report `0`. |
| `n`        | `number` | Number of samples (eval-set rollouts) behind the estimate. `>= 1`.              |

`ScoreRecord`:

| Field        | Type                                       | Notes                                                     |
| ------------ | ------------------------------------------ | -------------------------------------------------------- |
| `skill`      | `SkillDocHash`                             | Which skill version was scored.                          |
| `evalSet`    | `EvalSetHash`                              | Which eval set it was scored against.                    |
| `behavioral` | `ScoreDimension`                           | Pinned Pareto-dominant dimension (REQUIRED).             |
| `dimensions` | `Readonly<Record<string, ScoreDimension>>` | All scored dimensions, keyed by name; MUST include `behavioral`. |

The pinned dimension key is exported as `BEHAVIORAL_DIMENSION = "behavioral"`. The full dimension set is pinned in the `@intentsolutions/core` SkillVersion schema (CISO determinism binding); this package pins only the behavioral key the predicate is anchored on.

### 3.4 Edit ops and `EditProposal`

A bounded edit op is a SkillOpt-style add / delete / replace, each anchored to an **exact** substring of the doc.

| Op type     | Discriminant      | Fields                                                              |
| ----------- | ----------------- | ------------------------------------------------------------------ |
| `AddOp`     | `kind: "add"`     | `after` (exact anchor substring), `content` (text inserted after). |
| `DeleteOp`  | `kind: "delete"`  | `target` (exact substring to remove).                              |
| `ReplaceOp` | `kind: "replace"` | `target` (exact substring), `content` (replacement).               |

`EditOp` is the discriminated union `AddOp | DeleteOp | ReplaceOp`.

`EditProposal` — a proposed bounded edit emitted by a `RefinerStrategy`. Carries `refinerStrategyId` so the proposal is mechanism-traceable (DR-028 P0-RATIFY-5 / AC-13).

| Field               | Type                | Notes                                                        |
| ------------------- | ------------------- | ----------------------------------------------------------- |
| `parent`            | `SkillDocHash`      | Hash of the skill doc this proposal edits.                  |
| `ops`               | `readonly EditOp[]` | The bounded edit ops (≤ `MAX_OPS_PER_PROPOSAL` = 8).         |
| `refinerModel`      | `string`            | Model identifier that produced the proposal.                |
| `refinerStrategyId` | `RefinerStrategyId` | Which strategy produced this proposal (signed downstream).  |
| `rationale`         | `string`            | Verbatim natural-language rationale from the strategy.      |

### 3.5 `EvalItem`, `EvalSet`, and `EvalSetRef`

`EvalItem` — a single graded item (`id`, `prompt`, optional `expectation`, `adversarial`, and `provenance`). Provenance binds canonical source/review hashes, source case ID, and optional run/model identity.

`EvalSetSource` is `"synthetic" | "harvested" | "golden" | "hybrid"`. This package ships the `"synthetic"` source via `bootstrap`; harvested + golden ingestion are I/O adapters.

`EvalSet` — a held-out eval set with versioning + lineage (DR-028 P0-RATIFY-6): `hash`, `skillId`, `source`, `items`, `evalSetVersion`, `lineageParent` (or `null`), `refreshDueAt` (rfc3339, or `null` under `--quick`), and `lineageId` (UUIDv7).

`EvalSetRef` = `{ hash, version, lineage_id }` — the frozen-eval-set reference the `skill-refiner-pass/v1` predicate carries (see § 6.3). `deriveEvalSetRef(evalSet)` computes it; `EvalSetSchema` / `EvalSetRefSchema` are the Zod validators; `validateEvalSet` runs the schema; `isRefreshDue(evalSet, { now })` reports whether the set is past `refreshDueAt`.

### 3.6 `RejectionReason` and `AcceptResult`

`RejectionReason` is the machine-readable tag on a rejected edit:

| Reason                       | Meaning                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `no-behavioral-improvement`  | Candidate did not strictly (significantly) improve the behavioral dimension.                  |
| `regressed-named-dimension`  | Behavioral flat **and** a non-behavioral named dimension regressed.                           |
| `pareto-incomparable`        | Behavioral improved **but** another named dim regressed — the DR-028 tie-break.               |
| `incomparable-records`       | The two records were scored against different eval sets.                                      |

`AcceptResult` is the discriminated union:

```ts
type AcceptResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: RejectionReason };
```

`DEFAULT_ALPHA = 0.05` is the exported default significance level (DR-028 P0-RATIFY-1).

---

## 4. Content addressing

```ts
function sha256(text: string): string;          // lowercase-hex SHA-256 of a UTF-8 string
function canonicalJson(value: unknown): string; // key-sorted JSON; arrays preserve order
function hashSkillDoc(text: string): string;    // content address of a SKILL.md
function hashValue(value: unknown): string;     // content address of any value via canonical JSON
```

Deterministic SHA-256 over canonical-JSON / UTF-8 using the Node `node:crypto` builtin — no external dependency, no I/O. `canonicalJson` sorts object keys recursively so structurally-equal values hash identically; arrays preserve order (meaningful for edit ops + eval items). This is the basis for the append-only content-addressed store (AC-2) and for comparing whether two `ScoreRecord`s refer to the same skill.

---

## 5. Pure operations

### 5.1 `applyEdit` / `makeSkillDoc`

```ts
function applyEdit(doc: SkillDoc, proposal: EditProposal): SkillDoc;
function makeSkillDoc(skillId: string, text: string): SkillDoc;
class EditApplicationError extends Error { readonly op: EditOp; }
```

Applies a bounded `EditProposal` to a `SkillDoc`, returning a **new** `SkillDoc` with a freshly computed hash (append-only, AC-2 — never mutates the input). Each op anchors to an **exact** substring; an anchor that is missing **or** ambiguous (more than one occurrence) fails loudly with `EditApplicationError` — silent partial application would corrupt the audit trail.

- `throws EditApplicationError` if `proposal.parent !== doc.hash`, or if any op's anchor/target is empty, missing, or ambiguous.
- `makeSkillDoc(skillId, text)` is the convenience constructor that builds a `SkillDoc` value (computing the hash) from raw text.

### 5.2 `bootstrap`

```ts
function bootstrap(doc: SkillDoc, opts?: BootstrapOptions): EvalSet;

interface BootstrapOptions {
  readonly evalSetVersion?: string;         // default "1.0.0"
  readonly lineageParent?: string | null;   // default null (root)
  readonly lineageId?: string;              // UUIDv7; derived deterministically for roots
  readonly quick?: boolean;                 // default false
  readonly now?: string;                    // rfc3339; injected for determinism
}
```

Synthesizes a **deterministic** synthetic `EvalSet` from a skill doc (AC-6 — eval-set bootstrap is non-optional). Given identical `doc.text` + `opts`, it always produces the identical `EvalSet`, including its hash and lineage id. The clock is the only non-pure input and is injected via `opts.now`. `refreshDueAt` is `now + 90 days` unless `quick` is set (then `null`, the VP DevRel binding for casual contributors). `throws RangeError` if `opts.now` is supplied but is not a valid rfc3339 timestamp.

### 5.3 `accept` — the acceptance gate (the durable contribution, AC-7)

```ts
function accept(baseline: ScoreRecord, candidate: ScoreRecord, alpha?: number): AcceptResult;
function isSignificantImprovement(candidate: ScoreDimension, baseline: ScoreDimension, alpha?: number): boolean;
function isSignificantRegression(candidate: ScoreDimension, baseline: ScoreDimension, alpha?: number): boolean;
```

**The heart of the package.** A pure predicate implementing DR-028 P0-RATIFY-1 exactly. `accept()` returns `{ accepted: true }` **only** when the candidate Pareto-dominates the baseline:

1. **Strict, significant improvement** on the kernel-pinned `behavioral` dimension — a one-sided significance test at α (default `0.05`) over each dimension's variance + sample count.
2. **Non-regression** on every other named dimension — a statistically *insignificant* dip is tolerated; a *significant* drop is a regression. A candidate that stops measuring a baseline dimension is treated as a regression (it dropped a measured guarantee).

The accept-predicate semantics stated formally: **strict-improvement-on-Pareto-dominant-behavioral-with-non-regressing-others.** The decision table:

| Behavioral improved? | A named dim regressed? | Result                                            |
| -------------------- | ---------------------- | ------------------------------------------------- |
| different eval sets  | —                      | reject `incomparable-records`                     |
| yes                  | no                     | `{ accepted: true }`                              |
| yes                  | yes                    | reject `pareto-incomparable` (DR-028 tie-break)   |
| no                   | yes                    | reject `regressed-named-dimension`                |
| no                   | no                     | reject `no-behavioral-improvement`                |

The significance test is a two-sample z-test on the difference of means using the variance + sample count carried on each `ScoreDimension`. A deterministic dimension (variance 0) reduces to an exact `>` / `<` comparison — the correct limiting behavior. The implementation maps common α levels to exact z critical values and falls back to Acklam's inverse-normal-CDF approximation otherwise — no external stats dependency. `isSignificantImprovement` and `isSignificantRegression` are the exported per-dimension building blocks `accept` composes.

---

## 6. Eval-set quality, slice-utility, and the 4-quadrant decision

### 6.1 Eval-set quality metrics

```ts
function coverage(evalSet: EvalSet): CoverageResult;
function capabilityCoverage(evalSet: EvalSet, manifest: CapabilityManifest): CapabilityCoverageResult;
function leakage(setA: readonly EvalItem[], setB: readonly EvalItem[]): LeakageResult;
function calibration(predictions: readonly CalibrationPrediction[]): CalibrationResult;
function adversarialPassRate(items: readonly AdversarialEvalItem[], results: readonly ItemResult[]): AdversarialPassRateResult;
function evaluateEvalSet(evalSet: EvalSet, opts?: EvaluateEvalSetOptions): EvalSetQualityReport;
```

Pure eval-set quality measurement (beads `214c.11`, `214c.13`): `coverage`
(legacy observed-category entropy), `capabilityCoverage` (declared sampling
completeness), `leakage` (train/held-out overlap), `calibration`
(predicted-vs-observed reliability), `adversarialPassRate` (robustness on
adversarial items), and `evaluateEvalSet` (the roll-up quality report).
The adapter's `assessProposal` / `refine assess` workflow (section 8.6) enforces
these quality preconditions. Computing this report or calling the pure
statistical `accept` predicate alone does not enforce them.

`CapabilityManifest` contains `skillId`, `evalSetHash`, `capabilities` (unique
`id` plus positive integer `minimumItems`), and `assignments` (`itemId` plus
distinct declared `capabilityIds`). It is reviewed input, not an inference from
prompt text or item names. The separate manifest preserves historical EvalSet
hashes. `evaluateEvalSet(..., { capabilityManifest })` adds a
`capabilityCoverage` result; without declarations the result is absent.
Consumers must also validate the eval-set content hash before trusting its
binding label.

`completeness` is the fraction of declared strata meeting their minimum count.
`strata` includes zero-count capabilities and each stratum's shortfall.
`complete` additionally requires every item to have a reviewed assignment;
`unassignedItemIds` lists those lacking one. Unknown or duplicate assignments,
duplicate declarations, and mismatched skill/hash bindings throw. A uniform
observed distribution can have entropy one while declared completeness is less
than one; these are different measurements.

`leakage` matches canonical prompts (trimmed and lowercased) one-to-one across
distinct arrays. Its ratio is the multiset intersection count divided by the
smaller array length, so it is symmetric and bounded by zero and one even when
prompts repeat. Matched IDs come from the first array in input order. Passing
the same array reference instead reports duplicate occurrences after the first
per prompt, divided by that array length. Empty inputs return zero.
`calibration` rejects non-finite confidences and values outside `[0, 1]` with a
`RangeError`, including when called through `evaluateEvalSet`.

### 6.2 Slice-utility (LOBO causal attribution)

```ts
const NO_SKILL_LEVEL_AGGREGATE = true;
function sliceIntoBlocks(doc: SkillDoc): readonly Block[];
function gateEvalSet(quality: EvalSetQuality, opts?): EvalSetGateResult;
function computeSliceUtility(opts: ComputeSliceUtilityOptions): SliceUtilityReport;
```

COMPUTED per-block utility via **Leave-One-Block-Out** causal attribution (epic `intent-eval-lab#206`, bead `ig4h.3`): slice the `SKILL.md` into blocks, ablate each, re-score, and attribute the behavioral delta to each block. This is pure refiner-core — **not** a kernel entity and emits **no** signed bundle row (Rule 4). The report is a per-block **vector**; there is deliberately **no** skill-level aggregate (`NO_SKILL_LEVEL_AGGREGATE`, C3 / Rule 2 — averaging a causal-attribution vector into one scalar would destroy the signal). `gateEvalSet` refuses to compute slice-utility against an un-gated (low-quality) eval-set.

### 6.3 The 4-quadrant schema-validity × judge-verdict decision

```ts
function decide(inputs: DecideInputs): DecideOutcome;
function kernelSkillFrontmatterValidator(): SchemaValidator;
function extractFrontmatter(skillDocText: string): string | null;
function parseFrontmatterYaml(yamlBlock: string): Record<string, unknown> | null;
```

`decide()` (bead `iev7`) crosses two orthogonal axes — is the candidate `SKILL.md` **schema-valid** (per the kernel `authoring/v1` frontmatter validator) and did the **judge** accept it — into a 4-quadrant outcome: `AcceptDecision`, `RejectDecision`, or `LogToSchemaRevisionCandidatesDecision` (the interesting quadrant: judge liked it but the kernel schema rejected it → a candidate schema-revision signal, never a silent accept). `kernelSkillFrontmatterValidator()` is the `SchemaValidator` seam wired to the kernel's canonical frontmatter schema; `extractFrontmatter` + `parseFrontmatterYaml` are its pure helpers.

---

## 7. Cost meter, kernel-/judge-version contracts, and the adoption signal

### 7.1 Cost meter

```ts
function createCostMeter(skillHash: SkillDocHash, config: BudgetConfig): CostMeter;
function totalTokens(usage: ModelUsage): number;
```

I/O-free per-attempt token accounting (original bead `jqam`). Construction validates
a SHA-256 skill identity and nonnegative safe-integer caps. `record` validates the
matching skill, nonempty model, outcome and nonnegative safe-integer usage. Unsafe
combined or accumulated totals throw before any accounting changes. Inputs and
returned budget, attempt and quarantine snapshots are detached; changing one
cannot alter accounting or later admission decisions.

`acceptRollup` totals **all** recorded calls, including rejected/pending calls;
`acceptedAttempts` counts accepted records without filtering the cost total.
Record a call exactly once. `record` appends and does not change an earlier
outcome. `checkBudget` returns a quarantine value when accumulated usage or
attempts meet (`>=`) a cap; attempt limits take priority. Zero caps deny admission.
The caller must check before starting another call. `record` still accepts valid
already-incurred usage after a cap, so accounting cannot silently discard spend.

This helper does not execute requests, persist a queue, price USD or enforce
runtime admission by itself. The current `createRefinerModel` adapter still emits
zero-usage placeholders and does not invoke this meter. Full provider accounting,
USD budget policy, ledger/quarantine and OTel integration remain explicitly open
in `bd_000-projects-214c.18` / #403. The input/snapshot integrity repair is
`bd_000-projects-214c.18.1` / #404; it does not settle that broader requirement.

### 7.2 Kernel- and judge-version contracts

```ts
const CONSUMED_KERNEL_VERSION = "0.10.0";
function isBaselineSupersededByKernel(baseline: BaselineKernelRef, current?: string): boolean;
function makeSupersededBaselineRecord(baseline: BaselineKernelRef, ...): SupersededBaselineRecord;

const CONSUMED_JUDGE_VERSION = "claude-sonnet-4-5";
function isBaselineSupersededByJudge(baseline: BaselineJudgeRef, current?: string): boolean;
function makeVNextBaselineTrigger(baseline: BaselineJudgeRef, ...): VNextBaselineTrigger;
```

The consumed-version contracts (beads `s58e`, `99oc`): a stored baseline records the kernel version + judge version it was measured under. When either moves, the baseline is **superseded** and must be re-measured before an accept verdict against it is trusted — an accept computed against a stale-kernel or stale-judge baseline is not comparable. These are the re-baseline triggers, exposed as pure predicates + record constructors. `parseVersionTuple` / `compareVersions` are exported for testing.

### 7.3 Deterministic time-decay adoption signal

```ts
function computeAdoptionVerdict(observations: readonly AdoptionObservation[], opts: ComputeAdoptionOptions): AdoptionVerdict;
function toAdoptionObservations(events: readonly UsageEvent[], reviews: readonly HumanReview[], opts?: ToObservationsOptions): AdoptionObservation[];
const PROVISIONAL_ADOPTION_THRESHOLDS: AdoptionThresholds;
const NO_ROLLED_ADOPTION_SCORE = true;
```

A skill's adoption signal answers one question across N tenants and M CI runs: **"is this skill still earning its keep versus the bare model?"** (epic `intent-eval-lab#206`, bead `ig4h.4`; DR-103 D4/D5). It is a deterministic, time-decayed adoption **rate** joined with the baseline-value flag into a 2×2 verdict (`keep` / `watch` / `deprecate_review` / `obsolete_review` / `hold`), **AND-combined never averaged** (`NO_ROLLED_ADOPTION_SCORE`, C3). It is **advisory and only ever DEPRECATES, never PROMOTES** — the deterministic `accept()` gate stays the shipping authority. The clock is injected via `opts.now`, so replay is reproducible. The **Thompson-sampling bandit is rejected** for this signable surface (DR-103 D5): a PRNG-driven verdict is non-deterministic and would break the Evidence-Bundle audit-reproducibility contract. `toAdoptionObservations` re-applies the kernel anti-gaming invariant (`source_verified`) at ingestion. Thresholds ship `provisional: true` until back-tested.

---

## 8. The swappable mechanism (AC-13)

The Refiner **mechanism** is swappable behind a typed interface; the **acceptance gate** (`accept()`, § 5.3) is not — that split is the AC-7 bitter-lesson hedge. To keep strategies unit-testable as pure code, the model call is **injected** as a `RefinerModel` rather than baked in. Source: `packages/refiner-core/src/strategies/`.

### 8.1 Collaborators + `RefinerStrategy`

```ts
interface RefinerModel {
  readonly id: string;                        // stable model id, recorded on the proposal
  complete(prompt: string): Promise<CompletionResult>;
}
interface ScoredRollout {
  readonly score: ScoreRecord;
  readonly evalItemId: string;
  readonly transcript: string;
}
interface ProposeContext {
  readonly doc: SkillDoc;
  readonly rollouts: readonly ScoredRollout[];
  readonly model: RefinerModel;
}
interface RefinerStrategy {
  readonly id: RefinerStrategyId;             // stable, signable identifier
  readonly description: string;               // human-readable; surfaced in the Evidence Report
  propose(ctx: ProposeContext): Promise<EditProposal>;
}
```

The **declare-only** swappable mechanism. Per the conformance suite, an implementation MUST return a proposal whose `parent === ctx.doc.hash` and whose `refinerStrategyId === this.id`. Per the CISO binding, every strategy has a stable `id`, recorded on the `EditProposal` and signed in the predicate payload — so a swappable mechanism never becomes an untraceable one.

### 8.2 Reference impl — `NaiveInContextStrategy`

```ts
class NaiveInContextStrategy implements RefinerStrategy {}
const NAIVE_IN_CONTEXT_STRATEGY_ID = "naive-in-context/v1";
```

The **null-hypothesis baseline** (DR-028 P0-RATIFY-3/5). Single pass: drop the whole skill doc into the model context, ask for a minimal bounded improvement, take whatever bounded ops come back. No scored-rollout analysis, no targeted prompting, no iteration — deliberately the dumbest thing that could work. It doubles as the Phase A.0 baseline the proposed mechanism must beat by > 70% of projected lift, or Phase B descopes.

### 8.3 Reference impl — `SkillOptStyleStrategy`

```ts
class SkillOptStyleStrategy implements RefinerStrategy {}
const SKILL_OPT_STYLE_STRATEGY_ID = "skill-opt-style/v1";
function selectWorstRollouts(rollouts: readonly ScoredRollout[], k?: number): ScoredRollout[];
```

The SkillOpt-style mechanism (the text-space SGD analog): rather than dropping the whole doc in blind, it locates the **lowest-scoring** rollouts (the "gradient signal"), feeds the model the doc plus those failing transcripts, and asks for bounded edits targeted at the observed failures. `selectWorstRollouts` sorts rollouts ascending by behavioral score and returns the `k` weakest (default 3).

### 8.4 Op parsing + bounds enforcement

```ts
function parseProposalResponse(completion: string): ParsedProposal;
function extractJsonObject(text: string): string;
class OpParseError extends Error {}
const MAX_OPS_PER_PROPOSAL = 8;
```

Shared, pure op-parsing both reference strategies use, so the op grammar is validated identically across mechanisms. `extractJsonObject` extracts the first balanced JSON object from a completion (models often wrap JSON in prose or fences). `parseProposalResponse` validates the JSON against a Zod discriminated-union schema (add / delete / replace with non-empty anchors) and **truncates** to at most `MAX_OPS_PER_PROPOSAL = 8` ops (excess truncated, not an error — robust to over-eager models). It `throws OpParseError` if no parseable, schema-valid JSON is present.

---

### 8.5 Scoring adapter execution identity (2026-11-10 repair)

The I/O adapter in `packages/refiner/src/score.ts` executes the exact supplied
`SkillDoc.text` and `EvalSet.items`, after checking their existing content hashes
and skill identity. Each item needs an explicit expectation; draft bootstrap
prompts are not graded without reviewed expected behavior. The default runner
materializes a private temporary skill/spec/database and delegates to `j-rig eval`
with one scoped criterion per item. It refuses stub, incomplete, malformed, or
failed evaluations rather than manufacturing observations. Temporary state is
removed on success or failure; historical persisted records are unchanged.

See `packages/refiner/README.md` for the frozen-input JSON/CLI workflow and the
text-only `SkillDoc` boundary. This repair is `bd_000-projects-214c.14` /
[issue #393](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/393).
It does not prove the separate capability-quality integration required by
`bd_000-projects-214c.13` /
[issue #394](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/394).

The additive `scoreWithEvidence` adapter returns a `ScoreRecord` and complete
per-item results after validating frozen criterion/case identities and agreement
with the evaluator aggregate. Adversarial items require these verdicts even on
the legacy `score` path, and add an `adversarial_pass_rate` dimension with the
subset's passing fraction, Bernoulli variance, and sample count. Higher means
more adversarial cases satisfied their explicit expected behavior; `unsure`
does not pass. Sets with no adversarial items have no adversarial dimension.
These observations provide evidence for the acceptance-quality integration;
the assessment workflow below enforces its quality preconditions.

### 8.6 Reviewed quality before acceptance (214c.13)

`assessProposal(inputs, runner, validator?)` requires a frozen document, proposal,
eval set, explicit clock, scoring options, `AcceptanceQualityEvidence`, and
`AcceptanceQualityPolicy`. The adapter snapshots inputs, checks content/identity,
requires complete declared coverage, evaluates leakage and calibration against
explicit policy, and refuses absent/expired review evidence or refresh-due sets.
Calibration evidence identifies the exact judge provider/model; actual paired
scoring must agree. Reference items and calibration labels are reviewed caller
evidence, not independently authenticated facts. Policy has no default quality
thresholds. See the Refiner README for the complete JSON field contract.

Only after preconditions pass does it apply the proposal, freshly score both
versions on the same frozen items, and invoke the existing `decide` gate. The
adversarial dimension participates in non-regression. No historical ScoreRecord
can substitute for a fresh run. Schema-invalid improvements retain the existing
schema-revision-candidate outcome rather than becoming accepts.

Assessment requires 1–8 operations (the shared `MAX_OPS_PER_PROPOSAL` bound)
before evaluator I/O. Both score invocations pin `judgeProvider`/`judgeModel`
from reviewed quality evidence, overriding caller scoring options. The subprocess
forwards `--judge-provider`/`--judge-model`; Anthropic metadata reports the
resolved transport model ID. Calibration must name that concrete ID, since a
tier alias does not match the runtime identity. Ordinary scoring can still use
execution tiers. Tracked by `bd_000-projects-214c.16` /
[issue #398](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/398).

`refine assess` stores completed assessments with both documents, proposal,
eval-set content, item observations, quality evidence, and policy. Blocked
preconditions write no assessment. The best pointer remains human-gated. This
additive artifact does not alter existing EvalSet hashes, the pure `accept`
signature, or signed predicate schemas, and it is not a signed pass by itself.

### 8.7 Reviewed bootstrap sources (214c.15)

`bootstrapFromItems(doc, source, items, opts)` is the pure content-addressed
constructor used by synthetic bootstrap and validated adapters. Its hash preimage
is unchanged; optional item provenance is content-bearing. `EvalItemSchema`
preserves and validates source/review hashes, source case ID, and optional run/model.

`bootstrapReviewedSource(doc, source, review, kind, opts)` accepts harvested or
golden input only after matching skill identity, canonical source hash, review
time, explicit expectations, and source completion. Harvested sources come from
`j-rig eval --rollout-file`: an opt-in private, non-overwriting export of actual
functional observations. Golden traces are human-nominated. Outputs never become
expected labels implicitly. A review selects a nonempty subset of unique source
cases; foreign, missing, duplicated, failed, stub, or unreviewed input is refused.
The README defines the versioned input schemas and exact CLI examples.

The bootstrap CLI persists both source objects and the set immutably. The default
store creates files mode 0600 and directories mode 0700, tightening existing
store directories. Optional boolean adversarial review labels are retained in
hashed items so the result can enter assessment. Provenance
hashes resolve to the stored source and review; run IDs are scoped by the source
hash. `--parent-set-file` validates parent schema/hash/skill identity and preserves
its lineage; `--eval-set-version` must change for a child. Freshness follows the
existing 90-day/quick-mode contract. These local records do not authenticate a
reviewer or prove held-out independence; acceptance-quality checks still apply.

### 8.8 Legacy optimizer integration (214c.17)

Plan027 §4 Phase A/Phase C and §6 require runtime reuse of legacy proposals and
experiments. Their canonical contracts now live in public `refiner-core`; private
`@j-rig/core` re-exports them with its JudgmentResult specialization. Published
Refiner libraries do not depend on private eval-engine packages.

`createRefinerExperiment(inputs)` accepts a ChangeProposal, SkillDoc, EvalSet,
one-operation EditProposal, targetItemId, source `{runId, criterionId, evidenceHash}`,
and explicit `now`. It validates content identities, explicit unique eval labels,
criterion mapping and an effective atomic edit. Its deterministic experiment ID
binds the change, content identities, mapping and source. The full value is stored
under `hashValue(value)`; timestamps participate in the store address.

`validateProposedRefinerExperiment(unknown)` reconstructs a proposed root and
rejects tampering/resolved records. `assessOptimizerExperiment(inputs, runner,
validator?)` checks bound inputs before fresh `assessProposal` scoring. It accepts
only when the Refiner decision is ACCEPT, the mapped target changes false→true,
and every previously passing item still passes. An evaluated result appends an
immutable child with assessment/score hashes; blocked quality produces no child.
The weaker legacy evaluator throws for bound experiments.

`optimize` now creates these records from actual failure analysis when all bridge
flags are supplied; `refine assess --experiment` resolves them. The README gives
exact flags, source-retention behavior and the legacy truncated-digest limitation.
Source runs guide targeting, never substitute for fresh paired evidence. No best
pointer or document is promoted automatically. Tracked by #401 / 214c.17.

## 9. Build and test

```bash
pnpm --filter @intentsolutions/refiner-core run build
pnpm run test:coverage:refiner-core
```

Every export above has a co-located `*.test.ts` in `packages/refiner-core/src/`. The package is I/O-free, so tests inject deterministic stubs for the only non-pure seams (the clock and the `RefinerModel`).

---

## 10. References

- `intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md` — THE PLAN (§ 4 API surface).
- `intent-eval-lab/000-docs/028-AT-DECR-isedc-council-session-7-skill-refiner-plan-ratification-2026-05-27.md` — DR-028 (P0-RATIFY-1, -3, -5, -6; T1, T3 bindings).
- `intent-eval-lab/specs/skill-refiner-evidence-report/v1.0.0-draft/SPEC.md` — the Evidence Report contract the accept verdict is rendered into.
- `000-docs/026-AT-SPEC-refiner-core-api-2026-06-20.md` — the wave-1 (`0.1.0`) foundation surface this doc grows from.
- `packages/refiner-core/src/` — the authoritative source; each export's JSDoc is normative.
- `packages/refiner-core/README.md` — the foundation overview.
