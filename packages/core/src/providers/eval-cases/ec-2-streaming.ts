/**
 * EC-2 — streaming completion.
 *
 * Per PB-7 § 4 EC-2: same prompt as EC-1 but request streaming output.
 * The adapter MUST expose a streaming API surface.
 *
 * Pass criterion: stream yields at least one text_delta and exactly one
 * finish chunk; the assembled text matches what a non-streaming complete()
 * would have produced (within tolerance — providers occasionally emit
 * different content for streaming vs non-streaming).
 *
 * Metric recorded: number of chunks, time-to-first-byte, total duration.
 */
import type { Provider, CompletionRequest, StreamChunk } from "../types.js";
import type { ECPerModelOutcome, ECRunner } from "./types.js";
import { DEFAULT_MODELS } from "./types.js";
import { isProviderError } from "../errors.js";

const PROMPT = "List 3 things to remember when reviewing a pull request. Each item on its own line.";

export const runEC2: ECRunner = async (provider, options) => {
  const models = options?.models ?? DEFAULT_MODELS;
  const t0 = Date.now();
  const perModel: ECPerModelOutcome[] = [];

  for (const [vendor, model] of Object.entries(models)) {
    perModel.push(await runOne(provider, model, vendor));
  }

  return {
    ec: "EC-2",
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
  const req: CompletionRequest = {
    model,
    messages: [{ role: "user", content: PROMPT }],
    maxTokens: 256,
  };
  const tStart = Date.now();
  let firstByteAt: number | null = null;
  const collected: StreamChunk[] = [];

  try {
    for await (const chunk of provider.completeStream(req)) {
      if (firstByteAt === null && chunk.type === "text_delta") {
        firstByteAt = Date.now();
      }
      collected.push(chunk);
    }
  } catch (err) {
    return {
      model,
      pass: false,
      notes: `vendor=${vendor}: stream threw ${isProviderError(err) ? err.category : "unknown error"}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const finishChunks = collected.filter((c) => c.type === "finish");
  const textDeltas = collected.filter((c) => c.type === "text_delta");
  const tEnd = Date.now();

  if (finishChunks.length !== 1) {
    return {
      model,
      pass: false,
      notes: `vendor=${vendor}: expected exactly 1 finish chunk, got ${finishChunks.length}`,
    };
  }
  if (textDeltas.length === 0) {
    return {
      model,
      pass: false,
      notes: `vendor=${vendor}: zero text_delta chunks emitted`,
    };
  }

  return {
    model,
    pass: true,
    notes: `vendor=${vendor}: ${textDeltas.length} deltas, finish reason=${
      (finishChunks[0] as { finishReason: string }).finishReason
    }`,
    metric: {
      chunk_count: collected.length,
      text_delta_count: textDeltas.length,
      first_byte_ms: firstByteAt !== null ? firstByteAt - tStart : -1,
      total_ms: tEnd - tStart,
    },
  };
}
