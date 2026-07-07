/**
 * Skill Refiner — value types (foundation, Phase A).
 *
 * These are the pure, content-addressable value objects the Refiner loop
 * operates on. They are I/O-free by construction: no file handles, no model
 * clients, no network. Persistence + scoring + proposing live in the adapter
 * layer (wave 2+), behind the {@link RefinerStrategy} interface.
 *
 * Faithful to plan 027 § 4 Phase A API surface + DR-028 (Session 7) deltas:
 *   - P0-RATIFY-1: accept() is a Pareto-dominant-on-behavioral predicate.
 *   - P0-RATIFY-6: EvalSet carries eval_set_version + lineage_parent + refresh_due_at.
 *   - P0-RATIFY-5: a refiner_strategy_id is carried so a proposal is mechanism-traceable.
 *
 * Sources:
 *   - intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md
 *   - intent-eval-lab/000-docs/028-AT-DECR-isedc-council-session-7-...-2026-05-27.md
 */

/** A lowercase hex SHA-256 string (64 chars). Content address for an artifact. */
export type Sha256 = string;

/** Content address of a SKILL.md document. */
export type SkillDocHash = Sha256;

/** Content address of an eval set. */
export type EvalSetHash = Sha256;

/** Stable identifier of a {@link RefinerStrategy} reference implementation (P0-RATIFY-5). */
export type RefinerStrategyId = string;

/**
 * A SKILL.md document as a pure value. The Refiner never mutates a SkillDoc in
 * place; {@link applyEdit} returns a new value with a new {@link SkillDocHash}
 * (AC-2 append-only discipline).
 */
export interface SkillDoc {
  /** kebab-slug skill identifier, e.g. "validate-skillmd". */
  readonly skillId: string;
  /** Full SKILL.md text (frontmatter + body). */
  readonly text: string;
  /** Content address of `text`. Caller computes via {@link hashSkillDoc}. */
  readonly hash: SkillDocHash;
}

/**
 * The kernel-pinned behavioral dimension key. accept() requires strict
 * (significant) improvement on THIS dimension and non-regression on all others.
 * The full dimension set is pinned in @intentsolutions/core@0.3.0 SkillVersion
 * schema (DR-028 P0-RATIFY-1, CISO determinism binding) — wave 2+. Here we pin
 * only the behavioral key the predicate is anchored on.
 */
export const BEHAVIORAL_DIMENSION = "behavioral" as const;

/**
 * Multi-dimensional score record (AC-3, Goodhart-resistant — never collapsed to
 * a scalar). `behavioral` is the kernel-pinned Pareto-dominant dimension; all
 * other numeric dimensions are "named dims" that must not regress.
 *
 * Every named dimension carries a sample variance so the acceptance gate can
 * apply the α=0.05 significance threshold (DR-028 P0-RATIFY-1). A higher score
 * is always "better" for every dimension (callers normalize accordingly).
 */
export interface ScoreDimension {
  /** Point estimate of the dimension's score (higher is better). */
  readonly value: number;
  /**
   * Sample variance of the estimate. Used for the significance test. A
   * dimension scored deterministically (e.g. frontmatter checks) reports 0.
   */
  readonly variance: number;
  /** Number of samples behind the estimate (eval-set rollouts). >= 1. */
  readonly n: number;
}

/**
 * A scored measurement of one skill version against one eval set.
 *
 * `behavioral` and `readability` are named in plan 027 § 4; arbitrary
 * additional named dimensions are permitted (Goodhart-resistance), keyed by
 * dimension name. `behavioral` is REQUIRED (it is the Pareto-dominant axis).
 */
export interface ScoreRecord {
  readonly skill: SkillDocHash;
  readonly evalSet: EvalSetHash;
  /** Pinned Pareto-dominant dimension (REQUIRED). */
  readonly behavioral: ScoreDimension;
  /** All scored dimensions, keyed by name. MUST include `behavioral`. */
  readonly dimensions: Readonly<Record<string, ScoreDimension>>;
}

/** A single bounded edit op on a SKILL.md (SkillOpt-style add/delete/replace). */
export type AddOp = {
  readonly kind: "add";
  /** Insertion anchor — an exact substring after which `content` is inserted. */
  readonly after: string;
  readonly content: string;
};
export type DeleteOp = {
  readonly kind: "delete";
  /** Exact substring to remove. */
  readonly target: string;
};
export type ReplaceOp = {
  readonly kind: "replace";
  /** Exact substring to replace. */
  readonly target: string;
  readonly content: string;
};
export type EditOp = AddOp | DeleteOp | ReplaceOp;

/**
 * A proposed bounded edit to a skill doc, emitted by a {@link RefinerStrategy}.
 * Content-addressable via the parent hash + ops. Carries `refinerStrategyId`
 * so the proposal is mechanism-traceable (DR-028 P0-RATIFY-5 / AC-13).
 */
export interface EditProposal {
  /** Hash of the skill doc this proposal edits. */
  readonly parent: SkillDocHash;
  readonly ops: readonly EditOp[];
  /** Model identifier that produced the proposal (e.g. "claude-sonnet"). */
  readonly refinerModel: string;
  /** Which strategy produced this proposal (signed downstream). */
  readonly refinerStrategyId: RefinerStrategyId;
  /** Verbatim natural-language rationale from the strategy. */
  readonly rationale: string;
}

/** A single graded item in an eval set. */
export interface EvalItem {
  readonly id: string;
  readonly prompt: string;
  /** Optional expected-behavior note (golden trace / acceptance criterion). */
  readonly expectation?: string;
}

/** Provenance of an eval set's items (plan 027 § 4 / AC-6). */
export type EvalSetSource = "synthetic" | "harvested" | "golden" | "hybrid";

/**
 * A held-out eval set with versioning + lineage (DR-028 P0-RATIFY-6).
 *
 * `evalSetVersion` is semver; `lineageParent` is the hash of the prior eval
 * set (null for the root); `refreshDueAt` is an rfc3339 timestamp (90 days
 * default) or null when produced in `--quick` mode (VP DevRel binding);
 * `lineageId` is a UUIDv7 that identifies the eval-set lineage — all
 * versions of the eval set for the same skill share the same `lineageId`.
 * This is the value the predicate's `eval_set_ref.lineage_id` references.
 */
export interface EvalSet {
  readonly hash: EvalSetHash;
  readonly skillId: string;
  readonly source: EvalSetSource;
  readonly items: readonly EvalItem[];
  /** Semver of the eval set, e.g. "1.0.0". */
  readonly evalSetVersion: string;
  /** Hash of the prior eval set in the lineage, or null for the root. */
  readonly lineageParent: EvalSetHash | null;
  /** rfc3339 refresh-due timestamp, or null when bootstrapped in --quick mode. */
  readonly refreshDueAt: string | null;
  /**
   * UUIDv7 that identifies the eval-set lineage. All versions of the same
   * eval set (for the same skill) share this id. Used by the predicate's
   * `eval_set_ref.lineage_id` field (DR-082 § 5.1). Root sets derive this
   * deterministically from skillId + source; child sets inherit from parent.
   */
  readonly lineageId: string;
}

/**
 * A reference to a frozen eval set as consumed by the `skill-refiner-pass/v1`
 * predicate body's `eval_set_ref` field (DR-082 § 5.1).
 *
 * - `hash`       — `sha256:`-prefixed content hash; pins exact content.
 * - `version`    — which published eval-set version (minLength 1).
 * - `lineage_id` — UUIDv7 of the eval-set lineage; pins the lineage.
 */
export interface EvalSetRef {
  /** sha256-prefixed content hash of the eval set, e.g. `"sha256:<64 hex>"`. */
  readonly hash: string;
  /** Published eval-set version string, e.g. `"1.0.0"`. minLength 1. */
  readonly version: string;
  /** UUIDv7 lineage identifier. */
  readonly lineage_id: string;
}

/** Reasons an {@link EditProposal} is rejected by {@link accept}. */
export type RejectionReason =
  /** Candidate did not strictly (significantly) improve the behavioral dim. */
  | "no-behavioral-improvement"
  /** Candidate regressed at least one non-behavioral named dimension. */
  | "regressed-named-dimension"
  /** Neither version Pareto-dominates the other (DR-028 tie-break). */
  | "pareto-incomparable"
  /** The two records were scored against different skills or eval sets. */
  | "incomparable-records";

/**
 * Result of the acceptance gate. A REJECT carries a machine-readable reason
 * so the rejected-edit buffer (shown in the Evidence Report AAR) is auditable.
 */
export type AcceptResult =
  { readonly accepted: true } | { readonly accepted: false; readonly reason: RejectionReason };

/** Default significance level for the acceptance gate (DR-028 P0-RATIFY-1: α=0.05). */
export const DEFAULT_ALPHA = 0.05;
