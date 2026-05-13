export {
  DEFAULT_MODELS,
  type ECModelSet,
  type ECPerModelOutcome,
  type ECResult,
  type ECRunner,
  type ECRunnerOptions,
} from "./types.js";

export { runEC1 } from "./ec-1-single-completion.js";
export { runEC2 } from "./ec-2-streaming.js";
export { runEC3 } from "./ec-3-tool-calling.js";
export { runEC4, type EC4Options, type EC4Triggers } from "./ec-4-error-categories.js";
export { runEC5 } from "./ec-5-batching.js";

import type { Provider } from "../types.js";
import type { ECResult, ECRunnerOptions } from "./types.js";
import { runEC1 } from "./ec-1-single-completion.js";
import { runEC2 } from "./ec-2-streaming.js";
import { runEC3 } from "./ec-3-tool-calling.js";
import { runEC4, type EC4Options } from "./ec-4-error-categories.js";
import { runEC5 } from "./ec-5-batching.js";

export interface ECSuiteResult {
  provider: string;
  results: ECResult[];
  totalDurationMs: number;
}

/**
 * Run all 5 eval cases against a Provider in sequence. Per PB-7 § 11
 * process, this is what each prototype runs to produce the data the
 * Decision Record consumes.
 *
 * Returns one ECResult per case (5 total). The harness does NOT compute
 * the rubric scores; that's a separate scoring step that reads these
 * results + applies PB-7 § 5. Keeping execution and scoring separate
 * means re-scoring without re-running.
 */
export async function runFullECSuite(
  provider: Provider,
  options?: ECRunnerOptions & { ec4?: EC4Options },
): Promise<ECSuiteResult> {
  const t0 = Date.now();
  const results: ECResult[] = [];

  results.push(await runEC1(provider, options));
  results.push(await runEC2(provider, options));
  results.push(await runEC3(provider, options));
  results.push(await runEC4(provider, options?.ec4 ?? options));
  results.push(await runEC5(provider, options));

  return {
    provider: provider.name,
    results,
    totalDurationMs: Date.now() - t0,
  };
}
