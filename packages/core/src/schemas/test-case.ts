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
  expected_artifacts: z.array(z.string()).optional().describe("Expected output files or artifacts"),
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

/**
 * Whether the test case declares a deterministic output hook
 * (`expected_output_contains` or `expected_artifacts`). Presence of the array
 * is what counts, matching the historical runner check.
 */
function declaresExpectedOutput(tc: TestCase): boolean {
  return tc.expected_output_contains !== undefined || tc.expected_artifacts !== undefined;
}

/**
 * Whether the functional runner executes this test case (and so whether its
 * output is judged).
 *
 * Every non-adversarial case runs. An adversarial case runs when it declares an
 * expected output, or when it names at least one criterion in `criteria_ids`:
 * a case that names criteria is judged against them even without an expected
 * output ("judge-only"). The master blueprint (`000-docs/007` § 4.2) lists
 * adversarial cases as an execution-layer input, and before this rule an
 * adversarial case scoped to, for example, `no-prompt-leakage` was silently
 * never executed, so its blocker criterion was never judged.
 *
 * The only adversarial case that does not run is a trigger-only one:
 * `trigger_expectation` set and `criteria_ids: []`. `adversarialCaseScopeIssue`
 * rejects every other non-running shape at spec load.
 */
export function isFunctionallyExecuted(tc: TestCase): boolean {
  if (tc.tier !== "adversarial") return true;
  if (declaresExpectedOutput(tc)) return true;
  return (tc.criteria_ids?.length ?? 0) > 0;
}

/**
 * Spec-load check for adversarial cases that no layer would test, or that
 * would be judged against every criterion by default. Returns an error message,
 * or `null` when the case is well-formed.
 *
 * - No expected output and no `criteria_ids`: the default "all criteria" would
 *   judge functional criteria against a hostile prompt and manufacture false
 *   blockers (000-docs/028 bug class), so the author must name the criteria.
 * - No expected output, `criteria_ids: []` and no `trigger_expectation`: no
 *   layer tests the case at all.
 */
export function adversarialCaseScopeIssue(tc: TestCase): string | null {
  if (tc.tier !== "adversarial" || declaresExpectedOutput(tc)) return null;
  const fix =
    "Name the criteria its output is judged against in criteria_ids, add " +
    "expected_output_contains or expected_artifacts, or make it a trigger-only " +
    "case with trigger_expectation and criteria_ids: [].";
  if (tc.criteria_ids === undefined) {
    return (
      `adversarial test case "${tc.id}" declares no expected output and no criteria_ids, ` +
      `so it would be judged against every criterion. ${fix}`
    );
  }
  if (tc.criteria_ids.length === 0 && tc.trigger_expectation === undefined) {
    return (
      `adversarial test case "${tc.id}" declares no expected output, no criteria and no ` +
      `trigger_expectation, so no layer tests it. ${fix}`
    );
  }
  return null;
}
