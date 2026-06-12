/**
 * @intentsolutions/rollout-gate — thin, fail-closed rollout decision logic.
 *
 * Consumed by the `intent-rollout-gate` GitHub Action: feed it a
 * gate-result/v1 Evidence Bundle + a rollout policy, get allow/block back.
 */
export {
  decide,
  parseBundle,
  type Decision,
  type DecideResult,
  type EvaluatedRequiredGate,
  type EvaluatedRow,
  type ParseBundleResult,
  type ParsedRow,
} from "./decide.js";

export {
  parsePolicy,
  RolloutPolicySchema,
  ForbiddenDecisionSchema,
  type RolloutPolicy,
  type RolloutPolicyInput,
  type ForbiddenDecision,
} from "./policy.js";

// Convenience re-exports so consumers can type bundle rows without a direct
// @j-rig/core dependency.
export type { EvidenceStatement, GateResult } from "@j-rig/core";
