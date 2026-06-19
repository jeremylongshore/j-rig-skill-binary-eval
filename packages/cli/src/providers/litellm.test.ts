import { describe, expect, it } from "vitest";
import { isProviderError, runCisoGateG1, runCisoGateG2 } from "@j-rig/core";
import type { CompletionRequest } from "@j-rig/core";
import { LiteLlmProvider } from "./litellm.js";
import type { Transport, TransportRequest, TransportResponse } from "./transport.js";

/**
 * Deterministic fake transport. Captures the request the adapter built (so we
 * can assert on normalization) and returns a canned vendor-shaped response.
 *
 * Per PB-7, this is how the measurement prototype is exercised without live
 * keys: the adapter's REQUEST/RESPONSE NORMALIZATION is the measured surface,
 * not the raw socket. See `transport.ts`.
 */
function fakeTransport(
  handler: (req: TransportRequest) => TransportResponse | Promise<TransportResponse>,
): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (req) => {
    calls.push(req);
    return handler(req);
  };
  return { transport, calls };
}

const KEY = "sk-test-litellm-key-0123456789";

function okCompletion(content: string, finish = "stop"): TransportResponse {
  return {
    status: 200,
    json: {
      choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    },
  };
}

describe("LiteLlmProvider — construction + identity", () => {
  it("exposes the adapter name and a prototype version", () => {
    const { transport } = fakeTransport(() => okCompletion("hi"));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    expect(p.name).toBe("litellm");
    expect(p.version).toMatch(/prototype/);
  });
});

describe("LiteLlmProvider.complete — EC-1 single completion", () => {
  it("normalizes an OpenAI-shaped choice into a CompletionResult", async () => {
    const { transport, calls } = fakeTransport(() => okCompletion("the answer"));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "anthropic/claude-sonnet-4",
      messages: [{ role: "user", content: "q" }],
      maxTokens: 64,
      temperature: 0.2,
    });
    expect(result.text).toBe("the answer");
    expect(result.model).toBe("anthropic/claude-sonnet-4");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(result.finishReason).toBe("stop");

    // The request was routed to the OpenAI-compatible chat/completions surface
    // with the model id passed through (single-shape routing — R5.3).
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(calls[0]!.url).toMatch(/\/v1\/chat\/completions$/);
    expect(body.model).toBe("anthropic/claude-sonnet-4");
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0.2);
  });

  it("parses structuredOutput when responseSchema is provided", async () => {
    const { transport, calls } = fakeTransport(() =>
      okCompletion('{"verdict":"yes","reasoning":"because"}'),
    );
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      responseSchema: { type: "object" },
    });
    expect(result.structuredOutput).toEqual({ verdict: "yes", reasoning: "because" });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.response_format).toBeDefined();
  });

  it("maps cached token accounting when present", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: {
        choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
    }));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.usage.cachedInputTokens).toBe(4);
  });

  it("throws schema_violation when responseSchema requested but output is not JSON", async () => {
    const { transport } = fakeTransport(() => okCompletion("not json at all"));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    await expect(
      p.complete({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "q" }],
        responseSchema: { type: "object" },
      }),
    ).rejects.toMatchObject({ category: "schema_violation" });
  });

  it("maps content_filter finish_reason to refusal (not an error)", async () => {
    const { transport } = fakeTransport(() => okCompletion("", "content_filter"));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "google/gemini-2.5-pro",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.finishReason).toBe("refusal");
  });

  it("maps length finish_reason", async () => {
    const { transport } = fakeTransport(() => okCompletion("partial", "length"));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.finishReason).toBe("length");
  });

  it("serializes tool-result messages with tool_call_id + name", async () => {
    const { transport, calls } = fakeTransport(() => okCompletion("ok"));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    await p.complete({
      model: "openai/gpt-4o",
      messages: [
        { role: "user", content: "use tool" },
        { role: "tool", content: "42", toolName: "calc", toolCallId: "tc-1" },
      ],
    });
    const body = calls[0]!.body as Record<string, unknown>;
    const wire = body.messages as Array<Record<string, unknown>>;
    expect(wire[1]).toMatchObject({ role: "tool", tool_call_id: "tc-1", name: "calc" });
  });
});

describe("LiteLlmProvider — EC-4 error categories", () => {
  it("throws authentication on a short key without a network call", async () => {
    const { transport, calls } = fakeTransport(() => okCompletion("x"));
    const p = new LiteLlmProvider({ apiKey: "short", transport });
    await expect(
      p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] }),
    ).rejects.toMatchObject({ category: "authentication" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [404, "model_not_found"],
    [429, "rate_limit"],
    [408, "network_timeout"],
    [504, "network_timeout"],
    [500, "unknown"],
  ] as const)("maps HTTP %i to category %s", async (status, category) => {
    const { transport } = fakeTransport(() => ({
      status,
      json: { error: { message: `boom ${status}` } },
    }));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    await expect(
      p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] }),
    ).rejects.toMatchObject({ category });
  });

  it("maps an aborted transport throw to network_timeout", async () => {
    const transport: Transport = async () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    };
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    await expect(
      p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] }),
    ).rejects.toMatchObject({ category: "network_timeout" });
  });

  it("maps a generic transport throw to unknown", async () => {
    const transport: Transport = async () => {
      throw new Error("socket hangup");
    };
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const err = await p
      .complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] })
      .catch((e: unknown) => e);
    expect(isProviderError(err)).toBe(true);
    expect((err as { category: string }).category).toBe("unknown");
  });

  it("throws unknown when the proxy returns no choices", async () => {
    const { transport } = fakeTransport(() => ({ status: 200, json: { choices: [] } }));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    await expect(
      p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] }),
    ).rejects.toMatchObject({ category: "unknown" });
  });
});

describe("LiteLlmProvider.completeStream — EC-2 streaming", () => {
  it("yields a text_delta then a finish chunk", async () => {
    const { transport } = fakeTransport(() => okCompletion("streamed text"));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const chunks = [];
    for await (const c of p.completeStream({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    })) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ type: "text_delta", delta: "streamed text" });
    expect(chunks[1]!.type).toBe("finish");
  });

  it("omits the text_delta when the model returned empty text", async () => {
    const { transport } = fakeTransport(() => okCompletion(""));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const chunks = [];
    for await (const c of p.completeStream({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    })) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("finish");
  });
});

describe("LiteLlmProvider.callTool — EC-3 tool calling", () => {
  it("normalizes a tool_calls array into a ToolCallResult", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "tc-9", function: { name: "lookup", arguments: '{"q":"x"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      },
    }));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "anthropic/claude-sonnet-4",
      messages: [{ role: "user", content: "look it up" }],
      tools: [{ name: "lookup", description: "find", inputSchema: { type: "object" } }],
    });
    expect(result.toolName).toBe("lookup");
    expect(result.toolArguments).toEqual({ q: "x" });
    expect(result.toolCallId).toBe("tc-9");
    expect(result.finishReason).toBe("tool_use");
  });

  it("returns null tool fields when the model declines to call", async () => {
    const { transport } = fakeTransport(() => okCompletion("I won't call a tool"));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "no tool needed" }],
      tools: [{ name: "lookup", description: "find", inputSchema: { type: "object" } }],
    });
    expect(result.toolName).toBeNull();
    expect(result.toolArguments).toBeNull();
    expect(result.toolCallId).toBeNull();
    expect(result.text).toBe("I won't call a tool");
  });

  it("throws authentication on short key in callTool", async () => {
    const { transport } = fakeTransport(() => okCompletion("x"));
    const p = new LiteLlmProvider({ apiKey: "tiny", transport });
    await expect(
      p.callTool({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "q" }],
        tools: [{ name: "t", description: "d", inputSchema: {} }],
      }),
    ).rejects.toMatchObject({ category: "authentication" });
  });

  it("propagates a non-2xx status from callTool", async () => {
    const { transport } = fakeTransport(() => ({
      status: 429,
      json: { error: { message: "slow down" } },
    }));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    await expect(
      p.callTool({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "q" }],
        tools: [{ name: "t", description: "d", inputSchema: {} }],
      }),
    ).rejects.toMatchObject({ category: "rate_limit" });
  });

  it("tolerates malformed tool arguments by returning an empty object", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "tc-1", function: { name: "x", arguments: "{bad" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {},
      },
    }));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "x", description: "d", inputSchema: {} }],
    });
    expect(result.toolArguments).toEqual({});
  });
});

describe("LiteLlmProvider.batch — EC-5 concurrent batching", () => {
  it("returns results in order and per-request errors in-band", async () => {
    const transport: Transport = async (req) => {
      const body = req.body as Record<string, unknown>;
      if (body.model === "openai/bad") {
        return { status: 404, json: { error: { message: "no model" } } };
      }
      return okCompletion(`ok:${String(body.model)}`);
    };
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const reqs: CompletionRequest[] = [
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "1" }] },
      { model: "openai/bad", messages: [{ role: "user", content: "2" }] },
      { model: "anthropic/claude-sonnet-4", messages: [{ role: "user", content: "3" }] },
    ];
    const results = await p.batch(reqs);
    expect(results).toHaveLength(3);
    expect((results[0] as { text: string }).text).toBe("ok:openai/gpt-4o");
    expect(isProviderError(results[1])).toBe(true);
    expect((results[1] as { category: string }).category).toBe("model_not_found");
    expect((results[2] as { text: string }).text).toBe("ok:anthropic/claude-sonnet-4");
  });

  it("captures a thrown transport error in-band for the failing element", async () => {
    let n = 0;
    const transport: Transport = async () => {
      n += 1;
      if (n === 2) throw new Error("socket reset");
      return okCompletion("good");
    };
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const results = await p.batch([
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "a" }] },
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "b" }] },
    ]);
    expect((results[0] as { text: string }).text).toBe("good");
    expect(isProviderError(results[1])).toBe(true);
  });
});

describe("LiteLlmProvider — normalization edge cases (branch coverage)", () => {
  it("maps function_call finish_reason to tool_use", async () => {
    const { transport } = fakeTransport(() => okCompletion("x", "function_call"));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.finishReason).toBe("tool_use");
  });

  it("defaults unknown finish_reason to stop", async () => {
    const { transport } = fakeTransport(() => okCompletion("x", "weird_reason"));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.finishReason).toBe("stop");
  });

  it("treats a missing message content as empty text and zero usage", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: { choices: [{ message: {}, finish_reason: "stop" }] },
    }));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.text).toBe("");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("strips a trailing slash from a custom baseUrl", async () => {
    const { transport, calls } = fakeTransport(() => okCompletion("ok"));
    const p = new LiteLlmProvider({ apiKey: KEY, baseUrl: "https://proxy.local/", transport });
    await p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] });
    expect(calls[0]!.url).toBe("https://proxy.local/v1/chat/completions");
  });

  it('coerces non-object string tool args (e.g. "5") to an empty object', async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "tc-1", function: { name: "x", arguments: "5" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {},
      },
    }));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "x", description: "d", inputSchema: {} }],
    });
    expect(result.toolArguments).toEqual({});
  });

  it("accepts already-object tool args without re-parsing", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "tc-1", function: { name: "x", arguments: { a: 1 } } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {},
      },
    }));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "x", description: "d", inputSchema: {} }],
    });
    expect(result.toolArguments).toEqual({ a: 1 });
  });

  it("returns null tool args when the function has no arguments field", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: { content: "", tool_calls: [{ id: "tc-1", function: { name: "x" } }] },
            finish_reason: "tool_calls",
          },
        ],
        usage: {},
      },
    }));
    const p = new LiteLlmProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "x", description: "d", inputSchema: {} }],
    });
    expect(result.toolArguments).toBeNull();
  });
});

describe("LiteLlmProvider — CISO gates (PB-7 § 6)", () => {
  it("PASSES G-1 credential redaction", async () => {
    const testKey = "sk-test-G1-litellm-" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    const result = await runCisoGateG1({
      testKey,
      invokeProvider: async () => {
        const { transport } = fakeTransport(() => okCompletion("clean response"));
        const p = new LiteLlmProvider({ apiKey: testKey, transport });
        await p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] });
      },
    });
    expect(result.pass).toBe(true);
  });

  it("PASSES G-2 env-var spillover (spawns no subprocess)", async () => {
    const testKey = "sk-test-G2-litellm-" + "z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4";
    const prev = process.env.LITELLM_TEST_KEY;
    process.env.LITELLM_TEST_KEY = testKey;
    try {
      const result = await runCisoGateG2({
        testKey,
        invokeProvider: async () => {
          const { transport } = fakeTransport(() => okCompletion("clean response"));
          const p = new LiteLlmProvider({ apiKey: testKey, transport });
          await p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] });
        },
      });
      expect(result.pass).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LITELLM_TEST_KEY;
      else process.env.LITELLM_TEST_KEY = prev;
    }
  });
});
