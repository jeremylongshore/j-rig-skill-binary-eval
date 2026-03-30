import type { TestCase } from "../schemas/test-case.js";
import type { SkillRoster } from "./roster.js";
import type { TriggerProvider, TriggerResult, TriggerOutcome } from "./types.js";

/**
 * Run trigger simulation for a set of test cases against a skill roster.
 *
 * Uses the provided TriggerProvider to simulate skill selection.
 * The provider is an abstraction — can be a real LLM or a mock.
 */
export async function runTriggerTests(
  testCases: TestCase[],
  roster: SkillRoster,
  provider: TriggerProvider,
): Promise<TriggerResult[]> {
  const results: TriggerResult[] = [];

  // Only run test cases that have trigger expectations
  const triggerCases = testCases.filter((tc) => tc.trigger_expectation);

  for (const tc of triggerCases) {
    try {
      const { selected, reasoning } = await provider.selectSkill(
        tc.prompt,
        roster.all.map((e) => ({ name: e.name, description: e.description })),
      );

      const outcome = classifyOutcome(
        selected,
        tc.trigger_expectation!,
        roster.target.name,
      );

      results.push({
        test_case_id: tc.id,
        prompt: tc.prompt,
        expected: tc.trigger_expectation!,
        outcome,
        selected_skill: selected,
        reasoning,
      });
    } catch (err) {
      results.push({
        test_case_id: tc.id,
        prompt: tc.prompt,
        expected: tc.trigger_expectation!,
        outcome: "error",
        selected_skill: null,
        reasoning: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Classify a trigger outcome based on which skill was selected
 * versus what was expected.
 */
function classifyOutcome(
  selectedSkill: string | null,
  expected: "should_trigger" | "should_not_trigger",
  targetName: string,
): TriggerOutcome {
  const targetSelected = selectedSkill === targetName;
  const noneSelected = selectedSkill === null;
  const siblingSelected = !noneSelected && !targetSelected;

  if (expected === "should_trigger") {
    if (targetSelected) return "correct_trigger";
    if (siblingSelected) return "sibling_confusion";
    return "false_negative";
  }

  // expected === "should_not_trigger"
  if (noneSelected) return "correct_no_trigger";
  if (targetSelected) return "false_positive";
  // Sibling was selected — target correctly didn't trigger
  return "correct_no_trigger";
}
