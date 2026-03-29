import { z } from "zod";

/**
 * The eval contract is the human-readable, pre-negotiated definition of done.
 *
 * It captures what the skill is for, what should/shouldn't trigger it,
 * which failures are sacred, and what safety boundaries matter.
 *
 * Distinct from the eval spec: the spec is machine-executable criteria,
 * the contract is the negotiated agreement about what success means.
 */
export const EvalContractSchema = z.object({
  contract_version: z.literal("1.0").describe("Schema version for forward compatibility"),
  skill_name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, "Must be kebab-case")
    .describe("Name of the skill this contract governs"),
  purpose: z.string().min(1).describe("What the skill is for — one clear sentence"),
  trigger_boundary: z.object({
    should_trigger: z
      .array(z.string())
      .min(1)
      .describe("Prompt patterns that should activate the skill"),
    should_not_trigger: z
      .array(z.string())
      .min(1)
      .describe("Prompt patterns that should NOT activate the skill"),
  }),
  success_criteria: z
    .array(z.string())
    .min(1)
    .describe("What counts as successful execution — observable outcomes"),
  blockers: z
    .array(z.string())
    .min(1)
    .describe("Sacred failures that block release regardless of average score"),
  safety_boundaries: z
    .array(z.string())
    .optional()
    .describe("What the skill must never do (prompt leakage, overreach, etc.)"),
  baseline_expectation: z
    .string()
    .optional()
    .describe("What the naked model does without this skill — for obsolete review"),
  evidence_rules: z
    .object({
      require_artifacts: z
        .boolean()
        .default(false)
        .describe("Whether the skill must produce artifacts"),
      require_output_validation: z
        .boolean()
        .default(true)
        .describe("Whether output must be validated against expectations"),
    })
    .optional(),
});

export type EvalContract = z.infer<typeof EvalContractSchema>;
