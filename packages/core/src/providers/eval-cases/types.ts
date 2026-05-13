/**
 * Eval-case shared types.
 *
 * Source: PB-7 measurement protocol § 4 (eval cases) + § 5 (rubric).
 *
 * Each EC-N module exports `runECn(provider, options): Promise<ECnResult>`.
 * Results flow into the score-card that the Decision Record consumes
 * per § 10 acceptance criteria.
 */

import type { Provider } from "../types.js";

/** Models exercised by every eval case (§ 4 EC-1 declares 3 providers minimum). */
export interface ECModelSet {
  anthropic: string;
  openai: string;
  google: string;
}

/** Default model identifiers when caller doesn't specify. */
export const DEFAULT_MODELS: ECModelSet = {
  anthropic: "anthropic/claude-sonnet-4",
  openai: "openai/gpt-4o",
  google: "google/gemini-2.5-pro",
};

/** Per-model outcome for a given eval case. */
export interface ECPerModelOutcome {
  model: string;
  pass: boolean;
  notes: string;
  /**
   * Free-form per-case metric (e.g. "EC-2 latency" or "EC-5 batch efficiency").
   * Captured here so the score-card has the raw numbers.
   */
  metric?: Record<string, number | string | boolean>;
  error?: string;
}

/**
 * Result of running one eval case against one Provider.
 * The 4 rubric dimensions (§ 5) are derived FROM these results during scoring
 * — they are NOT scored inside each EC runner. That separation keeps the
 * runners pure (one EC = one observation) and lets a future scoring script
 * recompute scores without re-running the cases.
 */
export interface ECResult {
  ec: "EC-1" | "EC-2" | "EC-3" | "EC-4" | "EC-5";
  provider: string; // Provider.name
  perModel: ECPerModelOutcome[];
  /** Whether the EC ran end-to-end without harness errors (not "all models passed"). */
  harnessOk: boolean;
  /** Total wall-clock ms for the eval case. */
  durationMs: number;
}

export interface ECRunnerOptions {
  models?: ECModelSet;
  /** Per-call timeout in ms. Default 60s. */
  timeoutMs?: number;
}

export type ECRunner = (
  provider: Provider,
  options?: ECRunnerOptions,
) => Promise<ECResult>;
