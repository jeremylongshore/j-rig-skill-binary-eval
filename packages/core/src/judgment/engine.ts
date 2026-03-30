import type { Criterion } from "../schemas/criterion.js";
import type { ObservedOutcome } from "../execution/types.js";
import { runCheck } from "../checks/deterministic-registry.js";
import type { JudgeProvider, JudgmentResult } from "./types.js";

/**
 * Judge a set of criteria against an observed outcome.
 *
 * Deterministic checks run first (no API cost).
 * Judge-based criteria use the provided JudgeProvider.
 */
export async function judgeCriteria(
  criteria: Criterion[],
  outcome: ObservedOutcome,
  judgeProvider: JudgeProvider,
  options?: { model?: string },
): Promise<JudgmentResult[]> {
  const results: JudgmentResult[] = [];

  for (const criterion of criteria) {
    if (criterion.method === "deterministic") {
      results.push(judgeDeterministic(criterion, outcome));
    } else {
      results.push(
        await judgeWithLLM(criterion, outcome, judgeProvider, options?.model),
      );
    }
  }

  return results;
}

/**
 * Judge a deterministic criterion using the check registry.
 */
function judgeDeterministic(
  criterion: Criterion,
  outcome: ObservedOutcome,
): JudgmentResult {
  if (!criterion.deterministic_check) {
    return {
      criterion_id: criterion.id,
      verdict: "no",
      confidence: 1,
      reasoning: "Deterministic criterion has no check defined",
      method: "deterministic",
    };
  }

  const checkResult = runCheck(criterion.deterministic_check, outcome.output.text);

  return {
    criterion_id: criterion.id,
    verdict: checkResult.severity === "pass" ? "yes" : "no",
    confidence: 1,
    reasoning: checkResult.message,
    method: "deterministic",
  };
}

/**
 * Judge a criterion using an external LLM judge.
 */
async function judgeWithLLM(
  criterion: Criterion,
  outcome: ObservedOutcome,
  provider: JudgeProvider,
  model?: string,
): Promise<JudgmentResult> {
  try {
    const { verdict, confidence, reasoning } = await provider.judge(
      criterion.description,
      outcome.prompt,
      outcome.output.text,
      criterion.judge_prompt,
    );

    return {
      criterion_id: criterion.id,
      verdict,
      confidence,
      reasoning,
      method: "judge",
      judge_model: model,
    };
  } catch (err) {
    return {
      criterion_id: criterion.id,
      verdict: "unsure",
      confidence: 0,
      reasoning: `Judge error: ${err instanceof Error ? err.message : String(err)}`,
      method: "judge",
      judge_model: model,
    };
  }
}
