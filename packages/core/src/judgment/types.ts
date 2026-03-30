/**
 * Binary judgment: yes or no, with optional unsure.
 */
export type JudgmentVerdict = "yes" | "no" | "unsure";

/**
 * Result of judging a single criterion.
 */
export interface JudgmentResult {
  criterion_id: string;
  verdict: JudgmentVerdict;
  confidence: number;
  reasoning: string;
  method: "deterministic" | "judge";
  judge_model?: string;
}

/**
 * Golden case for calibration — known-correct judgment.
 */
export interface GoldenCase {
  criterion_id: string;
  prompt: string;
  output: string;
  expected_verdict: "yes" | "no";
  explanation: string;
}

/**
 * Calibration result — how well the judge matches golden cases.
 */
export interface CalibrationResult {
  total: number;
  correct: number;
  incorrect: number;
  unsure: number;
  accuracy: number;
  mismatches: Array<{
    criterion_id: string;
    expected: "yes" | "no";
    actual: JudgmentVerdict;
  }>;
}

/**
 * Provider interface for LLM-based judgment.
 * Abstracts the actual judge call so tests can use a mock.
 */
export interface JudgeProvider {
  judge(
    criterion_description: string,
    prompt: string,
    output: string,
    judge_prompt?: string,
  ): Promise<{ verdict: JudgmentVerdict; confidence: number; reasoning: string }>;
}
