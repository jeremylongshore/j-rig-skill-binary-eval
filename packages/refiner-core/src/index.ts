/**
 * @intentsolutions/refiner-core — Skill Refiner foundation (Phase A, wave 1).
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

// Kernel-bump propagation — consumed-kernel-version contract + re-baseline-superseded trigger (bead s58e)
export {
  CONSUMED_KERNEL_VERSION,
  isBaselineSupersededByKernel,
  makeSupersededBaselineRecord,
  // internal comparison utilities — exported for testing only
  parseVersionTuple,
  compareVersions,
} from "./kernel-version.js";
export type { BaselineKernelRef, SupersededBaselineRecord } from "./kernel-version.js";

// Judge-version pinning — consumed-judge-version contract + vNext-baseline trigger (bead 99oc)
export {
  CONSUMED_JUDGE_VERSION,
  isBaselineSupersededByJudge,
  makeVNextBaselineTrigger,
} from "./judge-version.js";
export type { BaselineJudgeRef, VNextBaselineTrigger } from "./judge-version.js";

// 4-quadrant schema-validity × judge-verdict decision matrix (bead iev7)
export type { SchemaValidityResult, SchemaValidator } from "./schema-validator.js";
export {
  extractFrontmatter,
  parseFrontmatterYaml,
  kernelSkillFrontmatterValidator,
} from "./schema-validator.js";
export type {
  AcceptDecision,
  RejectDecision,
  LogToSchemaRevisionCandidatesDecision,
  SchemaRevisionCandidate,
  DecideOutcome,
  DecideInputs,
} from "./decide.js";
export { decide } from "./decide.js";

// Eval-set quality metrics — coverage, leakage, calibration, adversarialPassRate (bead 214c.11)
export type {
  AdversarialEvalItem,
  CoverageBreakdown,
  CoverageResult,
  LeakageResult,
  CalibrationPrediction,
  CalibrationResult,
  ItemResult,
  AdversarialPassRateResult,
  EvaluateEvalSetOptions,
  EvalSetQualityReport,
} from "./eval-set-metrics.js";
export {
  coverage,
  leakage,
  calibration,
  adversarialPassRate,
  evaluateEvalSet,
} from "./eval-set-metrics.js";

// COMPUTED per-block slice-utility via Leave-One-Block-Out causal attribution
// (epic intent-eval-lab#206, bead bd_000-projects-ig4h.3). Pure refiner-core —
// NOT a kernel entity, emits NO signed bundle row (Rule 4). Per-block VECTOR,
// no skill-level aggregate (C3, Rule 2).
export type {
  Block,
  BlockScorer,
  EvalSetQuality,
  UngatedReason,
  EvalSetGateResult,
  BlockUtilityClass,
  BlockUtility,
  SliceUtilityReport,
  SliceMode,
  ComputeSliceUtilityOptions,
} from "./slice-utility.js";
export {
  NO_SKILL_LEVEL_AGGREGATE,
  gateEvalSet,
  sliceIntoBlocks,
  computeSliceUtility,
} from "./slice-utility.js";

// DETERMINISTIC time-decay adoption signal (epic intent-eval-lab#206, bead
// bd_000-projects-ig4h.4; ISEDC DR-103 D4 + D5). Consumes kernel UsageEvent +
// HumanReview; 2×2 baseline-value × decayed-adoption verdict, AND-combined never
// averaged (C3); advisory-and-deprecate-only; bandit REJECTED. now-injected.
export type {
  AdoptionEventSource,
  AdoptionObservation,
  AdoptionThresholds,
  BaselineValueAxis,
  AdoptionAxis,
  AdoptionVerdictKind,
  TenantAdoption,
  AdoptionVerdict,
  ComputeAdoptionOptions,
  ToObservationsOptions,
} from "./adoption.js";
export {
  NO_ROLLED_ADOPTION_SCORE,
  PROVISIONAL_ADOPTION_THRESHOLDS,
  computeAdoptionVerdict,
  toAdoptionObservations,
} from "./adoption.js";
