import { describe, it, expect } from "vitest";
import { mapProviderUsage, reportedModel } from "./usage.js";

describe("evaluator usage normalization", () => {
  it("preserves Anthropic cache-write TTL counts without double counting", () => {
    expect(
      mapProviderUsage(
        {
          input_tokens: 2,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 5,
          cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
        },
        "anthropic",
      ),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 3,
      cachedInputTokens: 4,
      cacheCreationInputTokens: 5,
      cacheCreation5mInputTokens: 2,
      cacheCreation1hInputTokens: 3,
    });
  });
  it("keeps OpenAI cache subsets separate from the total", () => {
    expect(
      mapProviderUsage(
        {
          prompt_tokens: 10,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
        },
        "openai",
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cachedInputTokens: 4,
      cacheCreationInputTokens: 2,
    });
  });
  it.each([undefined, null, {}, { prompt_tokens: -1, completion_tokens: 1 }])(
    "leaves missing/invalid counts unknown: %j",
    (value) => {
      expect(mapProviderUsage(value, "openai")).toBeNull();
    },
  );
  it("preserves explicit measured zero", () => {
    expect(mapProviderUsage({ prompt_tokens: 0, completion_tokens: 0 }, "openai")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
  it("does not substitute a requested model for an absent response model", () => {
    expect(reportedModel({ model: "actual" })).toBe("actual");
    for (const body of [null, {}, { model: " " }, { model: 1 }])
      expect(reportedModel(body)).toBeUndefined();
  });
});
