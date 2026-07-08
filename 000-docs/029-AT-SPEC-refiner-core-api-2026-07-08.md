# `@intentsolutions/refiner-core` Public API Specification (v0.2.0)

**Date:** 2026-07-08
**Status:** NORMATIVE for the `@intentsolutions/refiner-core@0.2.0` published surface
**Package:** `@intentsolutions/refiner-core` (published to npm, version `0.2.0`)
**Source of truth:** `packages/refiner-core/src/` — the JSDoc on each export is authoritative; this doc explains the surface, the accept-predicate semantics, and the swappable-mechanism contract.
**Supersedes (as the current surface):** `000-docs/026-AT-SPEC-refiner-core-api-2026-06-20.md`, which documents the wave-1 `0.1.0` foundation. This doc covers the grown `0.2.0` surface (the adoption signal, slice-utility, the 4-quadrant `decide()`, eval-set quality metrics, the kernel/judge-version contracts, and the schema-validator seam) added since. Where the two agree, 026's rationale still applies; where they differ, this doc + the source JSDoc win.

## Tri-link (AC-12 / DR-028 T3)

Per DR-028 T3 (`bd` is the canonical writer; GitHub and Plane are projections), this refiner-labeled artifact carries the three-layer cross-reference.

| Layer            | Identifier                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Bead (canonical) | `bd_000-projects-214c.5` (refiner-core public-API documentation)                                                    |
| GitHub issue     | [`jeremylongshore/j-rig-skill-binary-eval#81`](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/81) |
| Plane            | LAB module — Skill Refiner coordination (RC-IAJ)                                                                     |
| Coordination     | parent epic `bd_000-projects-214c`; product epic `bd_000-projects-3zol`                                             |

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
  bootstrap, type BootstrapOptions,
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

`EvalItem` — a single graded item (`id`, `prompt`, optional `expectation`).

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
function leakage(setA: readonly EvalItem[], setB: readonly EvalItem[]): LeakageResult;
function calibration(predictions: readonly CalibrationPrediction[]): CalibrationResult;
function adversarialPassRate(results: readonly ItemResult[], items: readonly AdversarialEvalItem[]): AdversarialPassRateResult;
function evaluateEvalSet(evalSet: EvalSet, opts?: EvaluateEvalSetOptions): EvalSetQualityReport;
```

Pure eval-set quality measurement (bead `214c.11`): `coverage` (stratification breakdown), `leakage` (train/held-out overlap), `calibration` (predicted-vs-observed reliability), `adversarialPassRate` (robustness on adversarial items), and `evaluateEvalSet` (the roll-up quality report). These gate whether an eval-set is trustworthy enough to derive an accept verdict against.

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
function createCostMeter(config: BudgetConfig): CostMeter;
function totalTokens(usage: ModelUsage): number;
```

I/O-free per-attempt token accounting (bead `jqam`): record each `propose()` attempt's `ModelUsage`, query the per-accept `AcceptRollup`, and enforce hard caps. When a token or attempt ceiling fires, the work is **not** silently dropped — it is routed to a quarantine queue as a `QuarantineRecord` carrying the reason + accumulated usage. The pipeline MUST check `CostMeter.checkBudget` before each attempt and stop on `{ continue: false }`. Real token counts come from the adapter layer; tests feed deterministic stubs.

### 7.2 Kernel- and judge-version contracts

```ts
const CONSUMED_KERNEL_VERSION = "0.9.0";
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
