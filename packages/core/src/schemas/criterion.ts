import { z } from "zod";

/**
 * How a criterion is evaluated.
 * - deterministic: checked by code (string match, file exists, regex, etc.)
 * - judge: evaluated by an external LLM judge
 */
export const CriterionMethod = z.enum(["deterministic", "judge"]);
export type CriterionMethod = z.infer<typeof CriterionMethod>;

/**
 * A single binary evaluation criterion.
 *
 * Every criterion resolves to yes or no. No gradients.
 * Blocker criteria block release regardless of other scores.
 */
export const CriterionSchema = z.object({
  id: z.string().min(1).describe("Unique identifier within the spec"),
  description: z.string().min(1).describe("Human-readable description of what is being checked"),
  method: CriterionMethod,
  blocker: z.boolean().default(false).describe("If true, failure blocks release"),
  regression_critical: z
    .boolean()
    .default(false)
    .describe("If true, regression on this criterion blocks release"),
  baseline_sensitive: z
    .boolean()
    .default(false)
    .describe("If true, compare against naked model performance"),
  pack_sensitive: z
    .boolean()
    .default(false)
    .describe("If true, evaluate in context of sibling skills"),
  judge_prompt: z
    .string()
    .optional()
    .describe("Prompt template for judge-based criteria"),
  deterministic_check: z
    .string()
    .optional()
    .describe("Check identifier for deterministic criteria (e.g. 'file_exists', 'regex_match')"),
});

export type Criterion = z.infer<typeof CriterionSchema>;
