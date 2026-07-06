/**
 * Binary judgment: yes or no, with optional unsure.
 */
export type JudgmentVerdict = "yes" | "no" | "unsure";

/**
 * Result of judging a single criterion.
 *
 * `samples` / `agreement` / `sample_verdicts` are ADDITIVE multi-sample fields:
 * absent on deterministic results and on legacy single-call judge results
 * (samples=1), so every existing consumer keeps its exact shape. When a judge
 * criterion is multi-sampled (N-sample majority voting), `verdict` is the
 * majority vote, `agreement` is the fraction of tallied samples that voted for
 * it, and `confidence` REUSES the existing field to carry that agreement
 * fraction — a real, observed number replacing the judge's self-reported (and
 * uncalibrated) confidence.
 */
export interface JudgmentResult {
  criterion_id: string;
  verdict: JudgmentVerdict;
  confidence: number;
  reasoning: string;
  method: "deterministic" | "judge";
  judge_model?: string;
  /** Judge samples tallied into this verdict (absent = single call). */
  samples?: number;
  /** Fraction of tallied samples agreeing with the majority verdict (multi-sample only). */
  agreement?: number;
  /** Per-sample verdicts in completion order (multi-sample only) — the audit trail of the noise. */
  sample_verdicts?: JudgmentVerdict[];
}

/**
 * Per-call options a judge provider MAY honor. Additive and optional so the
 * mock/stub providers (and any external implementation) remain valid without
 * change — a narrower implementation simply ignores it.
 */
export interface JudgeCallOptions {
  /**
   * Sampling temperature for THIS judge call. Multi-sample majority voting
   * samples at temperature > 0 to draw independent verdicts; single-call
   * judging keeps the provider default (0, greedy).
   */
  temperature?: number;
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
    options?: JudgeCallOptions,
  ): Promise<{ verdict: JudgmentVerdict; confidence: number; reasoning: string }>;
}
