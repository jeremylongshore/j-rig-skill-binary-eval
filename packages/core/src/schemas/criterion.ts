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
export const CriterionSchema = z
  .object({
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
    judge_prompt: z.string().optional().describe("Prompt template for judge-based criteria"),
    samples: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe(
        "Judge samples for THIS criterion (N-sample majority voting; verdict = majority, " +
          "confidence = agreement fraction). Overrides the spec-level `samples`. Ignored for " +
          "deterministic criteria. Omitted = single call (legacy).",
      ),
    judge_temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe(
        "Sampling temperature for judge calls on THIS criterion (overrides the spec-level " +
          "`judge_temperature`). Ignored for deterministic criteria.",
      ),
    deterministic_check: z
      .string()
      .optional()
      .describe("Check identifier for deterministic criteria (e.g. 'file_exists', 'regex_match')"),
    deterministic_check_params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Parameters forwarded to the deterministic check (e.g. { value: 'needle' } for 'contains', { pattern: '\\\\d+' } for 'regex_match')",
      ),
  })
  // A `deterministic` criterion with no `deterministic_check` has nothing to
  // evaluate. The engine historically returned a fake "no" for it at judgment
  // time — a synthetic failure that polluted the scorecard and could block
  // release. Catch it at spec-load instead, where it surfaces as a `validate`
  // error with a clear path, not a phantom blocker mid-run. (The engine retains
  // the same guard as defense-in-depth for any criterion that reaches it
  // without passing through this schema.)
  .refine((c) => c.method !== "deterministic" || !!c.deterministic_check, {
    message: "deterministic criteria must define deterministic_check",
    path: ["deterministic_check"],
  });

export type Criterion = z.infer<typeof CriterionSchema>;
