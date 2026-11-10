import {
  EvaluationTokenUsageSchema,
  hashValue,
  type EvaluationTokenUsage,
} from "@intentsolutions/refiner-core";
import { CostLedger } from "./cost-ledger.js";
import { readCompletionMeasurement } from "./completion-usage.js";

export interface CostCallContext {
  fileId: string;
  attemptId: string;
  provider: string;
  format: "anthropic" | "openai";
  phase: string | (() => string);
  onAdmissionRefused?: () => void;
}
/** Wrap the innermost transport, inside any retry layer: one reservation per wire attempt. */
export function createCostTransport<
  Request extends { body: unknown },
  Response extends { status: number; json: unknown },
>(
  inner: (request: Request) => Promise<Response>,
  ledger: CostLedger,
  context: CostCallContext,
): (request: Request) => Promise<Response> {
  const pinned = { ...context };
  return async (request) => {
    const admit = (): string => {
      const body = request.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof body.model !== "string" ||
        Object.keys(body).some(
          (key) =>
            ![
              "model",
              "messages",
              "max_tokens",
              "system",
              "stream",
              "n",
              "temperature",
              "top_p",
              "stop",
              "response_format",
              "reasoning_effort",
            ].includes(key),
        ) ||
        body.stream ||
        (body.n !== undefined && body.n !== 1) ||
        !Array.isArray(body.messages) ||
        body.messages.some(
          (message: unknown) =>
            !message ||
            typeof message !== "object" ||
            !("content" in message) ||
            typeof message.content !== "string",
        ) ||
        (body.system !== undefined && typeof body.system !== "string")
      )
        throw new Error("Cost admission requires bounded non-streaming text requests");
      const rate = ledger
        .snapshot()
        .policy.rates.find((r) => r.provider === pinned.provider && r.model === body.model);
      if (!rate || rate.format !== pinned.format)
        throw new Error("Missing explicit cost rate for transport");
      if (
        typeof body.max_tokens !== "number" ||
        !Number.isSafeInteger(body.max_tokens) ||
        body.max_tokens < 1 ||
        body.max_tokens > rate.maxOutputTokens ||
        BigInt(Buffer.byteLength(JSON.stringify(body), "utf8")) +
          BigInt(rate.protocolOverheadTokens) >
          BigInt(rate.maxInputTokens)
      )
        throw new Error("Request exceeds reviewed cost token bounds");
      return ledger.reserve({
        fileId: pinned.fileId,
        attemptId: pinned.attemptId,
        provider: pinned.provider,
        model: body.model,
        phase: typeof pinned.phase === "function" ? pinned.phase() : pinned.phase,
        outputLimit: body.max_tokens,
        requestHash: hashValue(body),
      });
    };
    let callId: string;
    try {
      callId = admit();
    } catch (error) {
      pinned.onAdmissionRefused?.();
      throw error;
    }
    let response: Response;
    try {
      response = await inner(request);
    } catch (error) {
      ledger.settle({ callId, outcome: "failed", reportedModel: null, usage: null });
      throw error;
    }
    const measurement = readCompletionMeasurement(response.json, pinned.format);
    let usage: EvaluationTokenUsage | null = measurement.usage
      ? {
          inputTokens: measurement.usage.promptTokens,
          outputTokens: measurement.usage.completionTokens,
        }
      : null;
    if (usage) {
      const fields: Record<string, keyof EvaluationTokenUsage> =
        pinned.format === "anthropic"
          ? {
              cache_read_input_tokens: "cachedInputTokens",
              cache_creation_input_tokens: "cacheCreationInputTokens",
              "cache_creation.ephemeral_5m_input_tokens": "cacheCreation5mInputTokens",
              "cache_creation.ephemeral_1h_input_tokens": "cacheCreation1hInputTokens",
            }
          : {
              "prompt_tokens_details.cached_tokens": "cachedInputTokens",
              "prompt_tokens_details.cache_write_tokens": "cacheCreationInputTokens",
            };
      for (const [wire, field] of Object.entries(fields)) {
        const value = measurement.billingTokens[wire];
        if (value !== undefined) usage[field] = value;
      }
      const valid = EvaluationTokenUsageSchema.safeParse(usage);
      usage = valid.success ? valid.data : null;
    }
    ledger.settle({
      callId,
      outcome: response.status >= 200 && response.status < 300 ? "completed" : "failed",
      reportedModel:
        measurement.reportedModel &&
        measurement.reportedModel.length <= 256 &&
        measurement.reportedModel.trim() === measurement.reportedModel
          ? measurement.reportedModel
          : null,
      usage,
    });
    return response;
  };
}
