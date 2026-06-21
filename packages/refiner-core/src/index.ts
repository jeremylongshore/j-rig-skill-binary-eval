/**
 * @j-rig/refiner-core — Skill Refiner foundation (Phase A, wave 1).
 *
 * The eval-guided improvement loop's pure core: value types, the bounded-edit
 * apply transform, the deterministic synthetic eval-set bootstrap, the
 * acceptance gate (DR-028 P0-RATIFY-1), and the swappable RefinerStrategy
 * interface (AC-13) with its two reference implementations.
 *
 * NOT in this foundation (gated / wave 2+): scoring/propose I/O adapters
 * (j-rig shell-out + Anthropic SDK), the content-addressed on-disk store + CLI,
 * the SkillVersion kernel entity, the skill-refiner-pass/v1 predicate URI, and
 * the Claude Code plugin + 3-layer hooks. See the package README + PR body.
 *
 * Plan: intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md
 */

// Value types
export type {
  Sha256,
  SkillDocHash,
  EvalSetHash,
  RefinerStrategyId,
  SkillDoc,
  ScoreDimension,
  ScoreRecord,
  AddOp,
  DeleteOp,
  ReplaceOp,
  EditOp,
  EditProposal,
  EvalItem,
  EvalSetSource,
  EvalSet,
  EvalSetRef,
  RejectionReason,
  AcceptResult,
} from "./types.js";
export { BEHAVIORAL_DIMENSION, DEFAULT_ALPHA } from "./types.js";

// EvalSet schema, validation, ref derivation, and refresh-due detection
export {
  UUIDV7_REGEX,
  SHA256_REGEX,
  SHA256_PREFIXED_REGEX,
  EvalItemSchema,
  EvalSetSourceSchema,
  EvalSetSchema,
  EvalSetRefSchema,
  validateEvalSet,
  deriveEvalSetRef,
  isRefreshDue,
  type IsRefreshDueOptions,
} from "./eval-set.js";

// Content addressing
export { sha256, canonicalJson, hashSkillDoc, hashValue } from "./hash.js";

// Pure operations
export { applyEdit, makeSkillDoc, EditApplicationError } from "./apply.js";
export { bootstrap, type BootstrapOptions } from "./bootstrap.js";
export { accept, isSignificantImprovement, isSignificantRegression } from "./accept.js";

// Cost meter — per-attempt usage, per-accept rollup, hard-cap quarantine
export type {
  ModelUsage,
  AttemptRecord,
  AttemptOutcome,
  BudgetConfig,
  QuarantineReason,
  QuarantineRecord,
  BudgetDecision,
  AcceptRollup,
  CostMeter,
} from "./cost.js";
export { totalTokens, createCostMeter } from "./cost.js";

// Swappable mechanism (AC-13)
export * from "./strategies/index.js";
