import type { TriggerResult, TriggerMetrics, ConfusionPair } from "./types.js";

/**
 * Compute trigger precision/recall metrics from test results.
 */
export function computeMetrics(results: TriggerResult[]): TriggerMetrics {
  let tp = 0, tn = 0, fp = 0, fn = 0, confusions = 0, errors = 0;

  for (const r of results) {
    switch (r.outcome) {
      case "correct_trigger": tp++; break;
      case "correct_no_trigger": tn++; break;
      case "false_positive": fp++; break;
      case "false_negative": fn++; break;
      case "sibling_confusion": confusions++; break;
      case "error": errors++; break;
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
  const fnr = fn + tp > 0 ? fn / (fn + tp) : 0;

  return {
    total_cases: results.length,
    true_positives: tp,
    true_negatives: tn,
    false_positives: fp,
    false_negatives: fn,
    sibling_confusions: confusions,
    errors,
    precision,
    recall,
    false_positive_rate: fpr,
    false_negative_rate: fnr,
  };
}

/**
 * Detect confusion pairs between skills from trigger results.
 *
 * A confusion pair exists when the target skill expected to trigger
 * but a sibling was selected instead (or vice versa).
 */
export function detectConfusion(
  results: TriggerResult[],
  targetName: string,
): ConfusionPair[] {
  const confusionMap = new Map<string, string[]>();

  for (const r of results) {
    if (r.outcome === "sibling_confusion" && r.selected_skill) {
      const key = r.selected_skill;
      const cases = confusionMap.get(key) ?? [];
      cases.push(r.test_case_id);
      confusionMap.set(key, cases);
    }
  }

  return [...confusionMap.entries()].map(([siblingName, cases]) => ({
    skill_a: targetName,
    skill_b: siblingName,
    confused_cases: cases,
    overlap_rate: cases.length / results.length,
  }));
}
