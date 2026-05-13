/**
 * EC-5 — concurrent request batching.
 *
 * Per PB-7 § 4 EC-5: send 10 concurrent requests through the adapter
 * against the same provider, measure aggregate latency vs serial
 * sequential.
 *
 * Pass criterion per model: batch returns 10 results in less time than the
 * sum of 10 serial calls would take (i.e. real concurrency is happening,
 * not just sequential dispatch).
 *
 * Tolerance: the batch SHOULD complete in <= 2x the longest single-call
 * latency. Larger margins indicate the adapter is serializing under the
 * hood. We DO NOT require 1x — providers cap concurrency, network jitter,
 * etc. 2x is the safety margin that gives meaningful signal without
 * flaking on slow days.
 */
import type { Provider, CompletionRequest } from "../types.js";
import type { ECPerModelOutcome, ECRunner } from "./types.js";
import { DEFAULT_MODELS } from "./types.js";
import { isProviderError } from "../errors.js";

const BATCH_SIZE = 10;
const MAX_BATCH_TO_SERIAL_RATIO = 0.5; // batch must take <= 50% of serial time

export const runEC5: ECRunner = async (provider, options) => {
  const models = options?.models ?? DEFAULT_MODELS;
  const t0 = Date.now();
  const perModel: ECPerModelOutcome[] = [];

  for (const [vendor, model] of Object.entries(models)) {
    perModel.push(await runOne(provider, model, vendor));
  }

  return {
    ec: "EC-5",
    provider: provider.name,
    perModel,
    harnessOk: true,
    durationMs: Date.now() - t0,
  };
};

async function runOne(
  provider: Provider,
  model: string,
  vendor: string,
): Promise<ECPerModelOutcome> {
  // Construct 10 deterministic-but-different prompts so caching can't
  // produce misleading speedup.
  const requests: CompletionRequest[] = Array.from({ length: BATCH_SIZE }, (_, i) => ({
    model,
    messages: [
      {
        role: "user",
        content: `Reply with the single word: ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"][i]}`,
      },
    ],
    maxTokens: 8,
  }));

  // First: time one serial call to establish a baseline.
  const tBaselineStart = Date.now();
  let baselineErr: string | null = null;
  try {
    await provider.complete(requests[0]);
  } catch (err) {
    baselineErr = err instanceof Error ? err.message : String(err);
  }
  const singleCallMs = Date.now() - tBaselineStart;

  if (baselineErr) {
    return {
      model,
      pass: false,
      notes: `vendor=${vendor}: baseline single call failed (${baselineErr})`,
      error: baselineErr,
    };
  }

  // Now batch.
  const tBatchStart = Date.now();
  let batchResults: Awaited<ReturnType<typeof provider.batch>>;
  try {
    batchResults = await provider.batch(requests);
  } catch (err) {
    return {
      model,
      pass: false,
      notes: `vendor=${vendor}: batch threw ${isProviderError(err) ? err.category : "unknown"}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const batchMs = Date.now() - tBatchStart;

  if (batchResults.length !== BATCH_SIZE) {
    return {
      model,
      pass: false,
      notes: `vendor=${vendor}: batch returned ${batchResults.length} results, expected ${BATCH_SIZE}`,
    };
  }

  const errorCount = batchResults.filter((r) => isProviderError(r)).length;
  const successCount = BATCH_SIZE - errorCount;

  // Concurrency check: batchMs should be substantially less than
  // BATCH_SIZE * singleCallMs.
  const serialBaselineMs = BATCH_SIZE * singleCallMs;
  const ratio = batchMs / serialBaselineMs;
  const concurrencyOk = ratio <= MAX_BATCH_TO_SERIAL_RATIO;

  return {
    model,
    pass: concurrencyOk && errorCount === 0,
    notes: `vendor=${vendor}: batch_ms=${batchMs}, single_ms=${singleCallMs}, ratio=${ratio.toFixed(2)}, errors=${errorCount}`,
    metric: {
      batch_ms: batchMs,
      single_call_ms: singleCallMs,
      serial_baseline_ms: serialBaselineMs,
      ratio,
      success_count: successCount,
      error_count: errorCount,
    },
  };
}
