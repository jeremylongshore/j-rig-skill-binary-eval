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
  /**
   * ADDITIVE: the test case this judgment row belongs to. A criterion judged
   * on multiple test cases produces one row per test case — without this id
   * the flattened vote-evidence array is ambiguous to automated consumers
   * (flagged on the first published vote-evidence bundle). Set by the eval
   * command; absent on synthetic rows (e.g. the self-test verdict).
   */
  test_case_id?: string;
  /** Judge samples tallied into this verdict (absent = single call). */
  samples?: number;
  /** Fraction of tallied samples agreeing with the majority verdict (multi-sample only). */
  agreement?: number;
  /**
   * Per-sample verdicts in DISPATCH order (multi-sample only) — the audit
   * trail of the noise. Promise.allSettled preserves input order, not
   * completion order; the majority fold is order-invariant, but any future
   * order-dependent fold (e.g. sequential quorum-lock early-stop) must record
   * its own ordering explicitly.
   */
  sample_verdicts?: JudgmentVerdict[];
  /**
   * Per-sample wall-clock latency in milliseconds, aligned index-for-index
   * with `sample_verdicts` (multi-sample only, absent on single-call). The
   * one signal an auditor needs to discount correlated votes — N samples
   * that all landed in the same burst window are weaker evidence of
   * independence than samples spread across distinct completions.
   */
  sample_latencies_ms?: number[];
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
  /**
   * Wall-clock budget for THIS judge call in milliseconds. A judge verdict is
   * a small structured completion — an unbounded hang is never right (a live
   * NVIDIA NIM call once hung a judge for over an hour). Real providers honor
   * it via AbortController; a timed-out call rejects and votes "unsure" under
   * the errored-sample semantics.
   */
  timeout_ms?: number;
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
