import type {
  ChangeProposal as SharedChangeProposal,
  Experiment as SharedExperiment,
  ExperimentStatus as SharedExperimentStatus,
} from "@intentsolutions/refiner-core";
import type { JudgmentResult } from "../judgment/types.js";

/**
 * A cluster of related failures.
 */
export interface FailureCluster {
  pattern: string;
  criterion_ids: string[];
  count: number;
  severity: "critical" | "high" | "medium";
}

/** Shared canonical contracts; the legacy API retains its JudgmentResult specialization. */
export type ChangeProposal = SharedChangeProposal;
export type ExperimentStatus = SharedExperimentStatus;
export type Experiment = SharedExperiment<JudgmentResult>;

/**
 * Provider interface for generating change proposals.
 * Abstracts the LLM call for optimization suggestions.
 */
export interface OptimizerProvider {
  proposeChange(
    failingCriteria: Array<{ id: string; description: string; reasoning: string }>,
    skillBody: string,
  ): Promise<ChangeProposal>;
}
