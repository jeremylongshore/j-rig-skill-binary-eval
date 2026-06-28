import type { Criterion } from "../schemas/criterion.js";

/**
 * Select the criteria that apply to a single test case.
 *
 * Each test case may carry a `criteria_ids` list naming exactly which criteria
 * it exercises (schema `test-case.ts`, "Which criteria this test case evaluates
 * (defaults to all)"). The eval pipeline historically ignored this field and
 * judged EVERY criterion against EVERY observed outcome — so an off-topic
 * criterion (e.g. a domain-specific functional check) got judged against an
 * unrelated control prompt, naturally returned "no", and — if the criterion was
 * a blocker — produced a FALSE blocker that inflated the NO-SHIP rate.
 *
 * Selection contract (backward-compatible with the documented default):
 *   - `criteriaIds` ABSENT (`undefined`)        → ALL criteria apply.
 *   - `criteriaIds` PRESENT (incl. empty `[]`)  → only the named criteria apply.
 *
 * An empty list is therefore meaningful: a control prompt that should be tested
 * only by the trigger layer (`trigger_expectation: should_not_trigger`) can
 * carry `criteria_ids: []` so NO functional criterion is judged against it.
 *
 * An id in `criteriaIds` with no matching criterion THROWS — a renamed or
 * misspelled id is a silent test gap (the very class of bug this scoping was
 * added to prevent), so we fail loud rather than under-evaluate. `EvalSpecSchema`
 * also cross-validates `criteria_ids` at spec-load, so a validated spec never
 * reaches here with an unknown id; this guard is the runtime defense-in-depth
 * for any criterion list that bypasses schema validation.
 */
export function selectCriteriaForTestCase(
  criteria: Criterion[],
  criteriaIds: string[] | undefined,
): Criterion[] {
  if (criteriaIds === undefined) return criteria;
  const available = new Set(criteria.map((c) => c.id));
  const unknown = criteriaIds.filter((id) => !available.has(id));
  if (unknown.length > 0) {
    throw new Error(`Test case references unknown criteria_ids: ${unknown.join(", ")}`);
  }
  const wanted = new Set(criteriaIds);
  return criteria.filter((c) => wanted.has(c.id));
}
