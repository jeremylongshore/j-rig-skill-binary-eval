import type { TokenUsage } from "@j-rig/core";
import { readCompletionMeasurement } from "@intentsolutions/refiner";

/** Share protocol normalization with proposing; absent/invalid measurements stay null. */
export function mapProviderUsage(raw: unknown, format: "anthropic" | "openai"): TokenUsage | null {
  const result = readCompletionMeasurement({ usage: raw }, format);
  if (!result.usage) return null;
  const usage: TokenUsage = {
    inputTokens: result.usage.promptTokens,
    outputTokens: result.usage.completionTokens,
  };
  const fields: Record<string, keyof TokenUsage> =
    format === "anthropic"
      ? ({
          cache_read_input_tokens: "cachedInputTokens",
          cache_creation_input_tokens: "cacheCreationInputTokens",
          "cache_creation.ephemeral_5m_input_tokens": "cacheCreation5mInputTokens",
          "cache_creation.ephemeral_1h_input_tokens": "cacheCreation1hInputTokens",
        } as const)
      : ({
          "prompt_tokens_details.cached_tokens": "cachedInputTokens",
          "prompt_tokens_details.cache_write_tokens": "cacheCreationInputTokens",
        } as const);
  for (const [wire, normalized] of Object.entries(fields)) {
    const value = result.billingTokens[wire];
    if (value !== undefined) usage[normalized] = value;
  }
  return usage;
}

export function reportedModel(body: unknown): string | undefined {
  const value = (body as Record<string, unknown> | null)?.model;
  return typeof value === "string" && value.trim() ? value : undefined;
}
