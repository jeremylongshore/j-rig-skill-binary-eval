import type { JudgmentResult } from "../judgment/types.js";
import type { BaselineComparison } from "./types.js";

/**
 * Compare skill results against baseline (no-skill) results.
 *
 * If the naked model matches the skill on most criteria,
 * the skill may be obsolete and should be flagged for review.
 */
export function compareBaseline(
  withSkillResults: JudgmentResult[],
  withoutSkillResults: JudgmentResult[],
): BaselineComparison[] {
  const comparisons: BaselineComparison[] = [];
  const baselineMap = new Map(withoutSkillResults.map((r) => [r.criterion_id, r]));

  for (const skillResult of withSkillResults) {
    const baseResult = baselineMap.get(skillResult.criterion_id);
    if (!baseResult) continue;

    const skillAddsValue = skillResult.verdict === "yes" && baseResult.verdict !== "yes";

    comparisons.push({
      criterion_id: skillResult.criterion_id,
      with_skill: skillResult.verdict,
      without_skill: baseResult.verdict,
      skill_adds_value: skillAddsValue,
    });
  }

  return comparisons;
}

/**
 * Check if a skill should be flagged for obsolete review.
 *
 * A skill is potentially obsolete if the baseline matches
 * the skill on most criteria (the skill adds no value).
 */
export function isObsoleteCandidate(
  comparisons: BaselineComparison[],
  threshold: number = 0.8,
): boolean {
  if (comparisons.length === 0) return false;
  const addsValue = comparisons.filter((c) => c.skill_adds_value).length;
  return addsValue / comparisons.length < 1 - threshold;
}
