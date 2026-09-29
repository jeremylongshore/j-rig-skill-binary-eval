export { detectRegressions } from "./regression.js";
export { compareBaseline, isObsoleteCandidate } from "./baseline.js";
export { computeScoreCard, decideRollout, buildLaunchReport } from "./scoring.js";
export type { BuildLaunchReportOptions } from "./scoring.js";
export { assessHeadroom, DEFAULT_HEADROOM_CEILING } from "./headroom.js";
export type { HeadroomAssessment, HeadroomInput, HeadroomStatus } from "./headroom.js";
export { loadSpecAuthority, classifyField, isValidEffort } from "./spec-sources.js";
export type {
  RolloutDecision,
  Regression,
  BaselineComparison,
  ScoreCard,
  LaunchReport,
  AdoptionVerdictSummary,
} from "./types.js";
export type { SpecAuthority } from "./spec-sources.js";
