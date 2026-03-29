import { z } from "zod";

/**
 * Test case tier determines when and how strictly it's evaluated.
 * - core: must always pass
 * - edge: boundary conditions
 * - regression: previously-passing cases that must not regress
 * - adversarial: intentionally hostile inputs
 */
export const TestCaseTier = z.enum(["core", "edge", "regression", "adversarial"]);
export type TestCaseTier = z.infer<typeof TestCaseTier>;

/**
 * Expected trigger behavior for this test case.
 * - should_trigger: the skill should activate
 * - should_not_trigger: the skill should stay silent
 */
export const TriggerExpectation = z.enum(["should_trigger", "should_not_trigger"]);
export type TriggerExpectation = z.infer<typeof TriggerExpectation>;

/**
 * A single test case for evaluating a skill.
 */
export const TestCaseSchema = z.object({
  id: z.string().min(1).describe("Unique identifier within the spec"),
  description: z.string().min(1).describe("What this test case checks"),
  tier: TestCaseTier,
  prompt: z.string().min(1).describe("The user prompt to send"),
  trigger_expectation: TriggerExpectation.optional().describe(
    "Whether the skill should or should not trigger",
  ),
  expected_artifacts: z
    .array(z.string())
    .optional()
    .describe("Expected output files or artifacts"),
  expected_output_contains: z
    .array(z.string())
    .optional()
    .describe("Strings that must appear in the output"),
  context_hints: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional context for the test runner"),
  criteria_ids: z
    .array(z.string())
    .optional()
    .describe("Which criteria this test case evaluates (defaults to all)"),
});

export type TestCase = z.infer<typeof TestCaseSchema>;
