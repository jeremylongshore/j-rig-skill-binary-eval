/**
 * Rollout policy — the consumer-facing knob set for `decide()`.
 *
 * Fail-closed defaults: `forbid_decisions` defaults to BOTH `fail` and
 * `error`; advisory rows only block when `advisory_blocks` is explicitly
 * set; unknown gates are tolerated unless `allow_unknown_gates` is
 * explicitly turned off; rows produced by the `stub` provider, or that
 * declare `ground_truth: false`, block unless the policy explicitly opts out
 * (STUB-PROVIDERS.md § 3: consumers MUST refuse stub-mode rows).
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
    /**
     * Producer providers whose rows block the rollout wherever they appear,
     * matched exactly against the row's `predicate.metadata.provider`.
     * Default: `["stub"]`. A row without a string `metadata.provider` is not
     * affected. An explicit `[]` turns the check off.
     */
    forbid_providers: z.array(z.string().min(1)).default(["stub"]),
    /**
     * When true, any row whose `predicate.metadata.ground_truth` is `false`
     * blocks the rollout: its verdict came from placeholder providers, not
     * from an evaluation. A row that does not declare `ground_truth` (a
     * deterministic gate, for example) is not affected. Default: true.
     */
    require_ground_truth: z.boolean().default(true),
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
