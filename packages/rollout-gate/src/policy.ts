/**
 * Rollout policy — the consumer-facing knob set for `decide()`.
 *
 * Fail-closed defaults: `forbid_decisions` defaults to BOTH `fail` and
 * `error`; advisory rows only block when `advisory_blocks` is explicitly
 * set; unknown gates are tolerated unless `allow_unknown_gates` is
 * explicitly turned off.
 */
import { z } from "zod";

/** Decisions that a policy may forbid anywhere in the bundle. */
export const ForbiddenDecisionSchema = z.enum(["fail", "error"]);
export type ForbiddenDecision = z.infer<typeof ForbiddenDecisionSchema>;

export const RolloutPolicySchema = z
  .object({
    /**
     * gate_id patterns that MUST each match at least one bundle row, and
     * every matched row MUST carry gate_decision="pass". `*` is the only
     * wildcard (matches any run of characters, including `:`); everything
     * else matches literally against the row's `predicate.gate_id`.
     */
    required_gates: z.array(z.string().min(1)),
    /**
     * Decisions that block the rollout wherever they appear in the bundle.
     * Default: both `fail` and `error` (fail closed).
     */
    forbid_decisions: z.array(ForbiddenDecisionSchema).default(["fail", "error"]),
    /** When true, any `advisory` row blocks the rollout. Default: false. */
    advisory_blocks: z.boolean().default(false),
    /**
     * When false, any row whose gate_id matches no `required_gates` pattern
     * blocks the rollout. Default: true (unknown gates are tolerated).
     */
    allow_unknown_gates: z.boolean().default(true),
  })
  .strict();

/** Fully-resolved policy (defaults applied). */
export type RolloutPolicy = z.infer<typeof RolloutPolicySchema>;
/** Accepted input shape (optional knobs may be omitted). */
export type RolloutPolicyInput = z.input<typeof RolloutPolicySchema>;

/**
 * Parse + validate an untrusted policy document. Throws `ZodError` on
 * garbage — callers MUST NOT fall back to a default policy on failure
 * (fail closed).
 */
export function parsePolicy(json: unknown): RolloutPolicy {
  return RolloutPolicySchema.parse(json);
}
