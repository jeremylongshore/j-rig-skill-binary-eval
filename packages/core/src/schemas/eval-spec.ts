import { z } from "zod";
import { CriterionSchema } from "./criterion.js";
import { TestCaseSchema } from "./test-case.js";

/**
 * Models that can be tested independently.
 */
export const ModelTarget = z.enum(["haiku", "sonnet", "opus"]);
export type ModelTarget = z.infer<typeof ModelTarget>;

/**
 * Sibling skill context — used when evaluating pack-sensitive criteria.
 */
export const SiblingSkillSchema = z.object({
  name: z.string().min(1).describe("Sibling skill name (kebab-case)"),
  description: z.string().min(1).describe("What the sibling does"),
  trigger_patterns: z
    .array(z.string())
    .optional()
    .describe("Prompts that should trigger the sibling instead"),
});

export type SiblingSkill = z.infer<typeof SiblingSkillSchema>;

/**
 * The eval spec is the machine-readable evaluation definition.
 *
 * It defines what criteria to check, what test cases to run,
 * which models to test, and what sibling context exists.
 */
export const EvalSpecSchema = z.object({
  spec_version: z.literal("1.0").describe("Schema version for forward compatibility"),
  skill_name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, "Must be kebab-case")
    .describe("Name of the skill being evaluated"),
  description: z.string().min(1).describe("What this eval spec covers"),
  criteria: z.array(CriterionSchema).min(1).describe("Binary criteria to evaluate"),
  test_cases: z.array(TestCaseSchema).min(1).describe("Test cases to run"),
  models: z
    .array(ModelTarget)
    .default(["sonnet"])
    .describe("Models to test independently"),
  siblings: z
    .array(SiblingSkillSchema)
    .optional()
    .describe("Sibling skills for pack-sensitive evaluation"),
  tags: z.array(z.string()).optional().describe("Categorization tags"),
});

export type EvalSpec = z.infer<typeof EvalSpecSchema>;
