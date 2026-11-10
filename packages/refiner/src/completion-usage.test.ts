import { describe, it, expect } from "vitest";
import { readCompletionMeasurement } from "./completion-usage.js";
import {
  AnthropicCompletionClient,
  OpenAICompatCompletionClient,
  createRefinerModel,
} from "./propose.js";

describe("completion measurements", () => {
  it("counts Anthropic cache tokens once and retains TTL billing fields", () => {
    expect(
      readCompletionMeasurement(
        {
          model: "actual",
          usage: {
            input_tokens: 5,
            output_tokens: 7,
            cache_read_input_tokens: 11,
            cache_creation_input_tokens: 30,
            cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
          },
        },
        "anthropic",
      ),
    ).toEqual({
      status: "reported",
      reportedModel: "actual",
      usage: { promptTokens: 46, completionTokens: 7 },
      billingTokens: {
        input_tokens: 5,
        output_tokens: 7,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 30,
        "cache_creation.ephemeral_5m_input_tokens": 10,
        "cache_creation.ephemeral_1h_input_tokens": 20,
      },
    });
  });
  it("does not double-count OpenAI cached or reasoning subsets", () => {
    const result = readCompletionMeasurement(
      {
        usage: {
          prompt_tokens: 30,
          completion_tokens: 20,
          total_tokens: 50,
          prompt_tokens_details: { cached_tokens: 15 },
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      },
      "openai",
    );
    expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 20 });
    expect(result.billingTokens["prompt_tokens_details.cached_tokens"]).toBe(15);
    expect(result.reportedModel).toBeNull();
  });
  it.each([null, {}, { usage: null }])("keeps absent usage unknown: %j", (body) => {
    expect(readCompletionMeasurement(body, "openai")).toMatchObject({
      status: "missing",
      usage: null,
    });
  });
  it.each([
    [],
    "bad",
    {},
    { prompt_tokens: 1 },
    { prompt_tokens: -1, completion_tokens: 0 },
    { prompt_tokens: 1.5, completion_tokens: 0 },
    { prompt_tokens: "1", completion_tokens: 0 },
    { prompt_tokens: Infinity, completion_tokens: 0 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
    { prompt_tokens: 2, completion_tokens: 3, total_tokens: 6 },
    { prompt_tokens: 2, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 3 } },
    { prompt_tokens: 2, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 4 } },
    { prompt_tokens: 2, completion_tokens: 3, prompt_tokens_details: "bad" },
  ])("refuses malformed usage: %j", (usage) => {
    expect(readCompletionMeasurement({ usage }, "openai")).toMatchObject({
      status: "invalid",
      usage: null,
    });
  });
  it("refuses inconsistent cache TTL counts", () => {
    expect(
      readCompletionMeasurement(
        {
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 9,
            cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 },
          },
        },
        "anthropic",
      ).status,
    ).toBe("invalid");
  });
  it("distinguishes reported zero from missing counts", () => {
    expect(
      readCompletionMeasurement({ usage: { input_tokens: 0, output_tokens: 0 } }, "anthropic"),
    ).toMatchObject({ status: "reported", usage: { promptTokens: 0, completionTokens: 0 } });
  });
  it("leaves legacy text clients unmeasured", async () => {
    expect(await createRefinerModel({ complete: async () => "text" }).complete("prompt")).toEqual({
      text: "text",
      usage: null,
    });
  });
  it("carries native Anthropic usage into the strategy model", async () => {
    const client = new AnthropicCompletionClient({
      apiKey: "test-key-only",
      transport: async () => ({
        status: 200,
        json: {
          model: "concrete",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 5, output_tokens: 7 },
        },
      }),
    });
    expect(await createRefinerModel(client).complete("prompt")).toEqual({
      text: "ok",
      usage: { promptTokens: 5, completionTokens: 7 },
    });
  });
  it("carries native OpenAI usage without changing text-only compatibility", async () => {
    const client = new OpenAICompatCompletionClient({
      apiKey: "test-key-only",
      baseUrl: "https://example.test",
      transport: async () => ({
        status: 200,
        json: {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        },
      }),
    });
    expect(await client.complete({ model: "test", prompt: "p" })).toBe("ok");
    expect(
      await createRefinerModel(client, { format: "openai", model: "test" }).complete("p"),
    ).toEqual({ text: "ok", usage: { promptTokens: 5, completionTokens: 7 } });
  });
});
