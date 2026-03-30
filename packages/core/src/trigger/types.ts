/**
 * The outcome of a single trigger test case.
 */
export type TriggerOutcome =
  | "correct_trigger"      // Target skill correctly activated
  | "correct_no_trigger"   // Target skill correctly stayed silent
  | "false_positive"       // Target skill activated when it shouldn't have
  | "false_negative"       // Target skill failed to activate when it should have
  | "sibling_confusion"    // A sibling skill was selected instead of the target
  | "none_selected"        // No skill was selected (may be correct or incorrect)
  | "error";               // System/API error during evaluation

/**
 * Result of evaluating a single trigger test case.
 */
export interface TriggerResult {
  test_case_id: string;
  prompt: string;
  expected: "should_trigger" | "should_not_trigger";
  outcome: TriggerOutcome;
  selected_skill: string | null;
  reasoning: string;
}

/**
 * Trigger precision/recall metrics for a skill.
 */
export interface TriggerMetrics {
  total_cases: number;
  true_positives: number;
  true_negatives: number;
  false_positives: number;
  false_negatives: number;
  sibling_confusions: number;
  errors: number;
  precision: number;
  recall: number;
  false_positive_rate: number;
  false_negative_rate: number;
}

/**
 * A confusion pair between two skills.
 */
export interface ConfusionPair {
  skill_a: string;
  skill_b: string;
  confused_cases: string[];
  overlap_rate: number;
}

/**
 * Provider interface for trigger simulation.
 * Abstracts the actual LLM call so tests can use a mock.
 */
export interface TriggerProvider {
  /**
   * Given a prompt and a list of available skills,
   * return which skill (if any) would be selected.
   */
  selectSkill(
    prompt: string,
    availableSkills: Array<{ name: string; description: string }>,
  ): Promise<{ selected: string | null; reasoning: string }>;
}
