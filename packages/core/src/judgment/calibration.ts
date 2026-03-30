import type { JudgeProvider, GoldenCase, CalibrationResult } from "./types.js";

/**
 * Run calibration against golden cases to measure judge accuracy.
 *
 * Golden cases are known-correct judgments that the judge should reproduce.
 * This catches judge drift, prompt regression, and model-specific biases.
 */
export async function runCalibration(
  goldenCases: GoldenCase[],
  provider: JudgeProvider,
): Promise<CalibrationResult> {
  let correct = 0;
  let incorrect = 0;
  let unsure = 0;
  const mismatches: CalibrationResult["mismatches"] = [];

  for (const golden of goldenCases) {
    const { verdict } = await provider.judge(
      golden.explanation,
      golden.prompt,
      golden.output,
    );

    if (verdict === "unsure") {
      unsure++;
      mismatches.push({
        criterion_id: golden.criterion_id,
        expected: golden.expected_verdict,
        actual: verdict,
      });
    } else if (verdict === golden.expected_verdict) {
      correct++;
    } else {
      incorrect++;
      mismatches.push({
        criterion_id: golden.criterion_id,
        expected: golden.expected_verdict,
        actual: verdict,
      });
    }
  }

  const total = goldenCases.length;
  return {
    total,
    correct,
    incorrect,
    unsure,
    accuracy: total > 0 ? correct / total : 1,
    mismatches,
  };
}
