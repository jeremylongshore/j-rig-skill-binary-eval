import type { JudgmentResult } from "../judgment/types.js";
import type { Experiment, ChangeProposal, ExperimentStatus } from "./types.js";

/**
 * Create a new experiment from a change proposal.
 */
export function createExperiment(
  proposal: ChangeProposal,
  beforeResults: JudgmentResult[],
): Experiment {
  return {
    id: `exp-${Date.now()}`,
    proposal,
    status: "proposed",
    before_results: beforeResults,
    after_results: undefined,
    improvement: null,
    created_at: new Date().toISOString(),
  };
}

/**
 * Evaluate an experiment by comparing before/after results.
 *
 * An experiment is accepted if:
 * 1. The target criterion now passes
 * 2. No other criterion regressed
 */
export function evaluateExperiment(
  experiment: Experiment,
  afterResults: JudgmentResult[],
): ExperimentStatus {
  if (!experiment.before_results) return "rejected";

  const targetId = experiment.proposal.target_criterion;
  const afterTarget = afterResults.find((r) => r.criterion_id === targetId);

  // Target must now pass
  if (!afterTarget || afterTarget.verdict !== "yes") {
    return "rejected";
  }

  // No regressions on other criteria
  const beforeMap = new Map(experiment.before_results.map((r) => [r.criterion_id, r]));

  for (const after of afterResults) {
    if (after.criterion_id === targetId) continue;
    const before = beforeMap.get(after.criterion_id);
    if (before?.verdict === "yes" && after.verdict !== "yes") {
      return "rejected"; // Regression on another criterion
    }
  }

  return "accepted";
}

/**
 * Check if an optimization should stop (early stopping).
 *
 * Stop conditions:
 * - All criteria pass
 * - Too many consecutive rejections (resistance)
 * - Maximum experiments reached
 */
export function shouldStop(
  results: JudgmentResult[],
  history: Experiment[],
  options: { maxExperiments?: number; maxConsecutiveRejections?: number } = {},
): { stop: boolean; reason: string } {
  const maxExp = options.maxExperiments ?? 10;
  const maxRejections = options.maxConsecutiveRejections ?? 3;

  // All criteria pass
  if (results.every((r) => r.verdict === "yes")) {
    return { stop: true, reason: "All criteria pass" };
  }

  // Max experiments
  if (history.length >= maxExp) {
    return { stop: true, reason: `Maximum experiments reached (${maxExp})` };
  }

  // Consecutive rejections (optimization resistance)
  const recentHistory = history.slice(-maxRejections);
  if (
    recentHistory.length >= maxRejections &&
    recentHistory.every((e) => e.status === "rejected")
  ) {
    return {
      stop: true,
      reason: `Optimization resistance: ${maxRejections} consecutive rejections`,
    };
  }

  return { stop: false, reason: "" };
}
