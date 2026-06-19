import { describe, expect, it } from "vitest";
import { isProviderError, runCisoGateG1, runCisoGateG2 } from "@j-rig/core";
import type { CompletionRequest } from "@j-rig/core";
import { VercelAiProvider } from "./vercel-ai.js";
import type { Transport, TransportRequest, TransportResponse } from "./transport.js";

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

const KEY = "sk-test-vercel-key-0123456789";

/** AI-SDK-normalized response: { text, usage, finishReason, toolCalls? }. */
function okGenerate(text: string, finish = "stop"): TransportResponse {
  return {
    status: 200,
    json: { text, usage: { inputTokens: 9, outputTokens: 4 }, finishReason: finish },
  };
}

describe("VercelAiProvider — construction + identity", () => {
  it("exposes the adapter name and a prototype version", () => {
    const { transport } = fakeTransport(() => okGenerate("hi"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    expect(p.name).toBe("vercel-ai-sdk");
    expect(p.version).toMatch(/prototype/);
  });
});

describe("VercelAiProvider.complete — EC-1 + vendor routing", () => {
  it.each([
    ["anthropic/claude-sonnet-4", /api\.anthropic\.com/, "claude-sonnet-4"],
    ["openai/gpt-4o", /api\.openai\.com/, "gpt-4o"],
    ["google/gemini-2.5-pro", /generativelanguage\.googleapis\.com/, "gemini-2.5-pro"],
  ] as const)(
    "routes %s to the right vendor endpoint with the bare model id",
    async (model, urlRe, bareId) => {
      const { transport, calls } = fakeTransport(() => okGenerate("ok"));
      const p = new VercelAiProvider({ apiKey: KEY, transport });
      const result = await p.complete({ model, messages: [{ role: "user", content: "q" }] });
      expect(result.model).toBe(model);
      expect(calls[0]!.url).toMatch(urlRe);
      expect((calls[0]!.body as Record<string, unknown>).model).toBe(bareId);
    },
  );

  it("throws model_not_found for an unknown vendor prefix", async () => {
    const { transport, calls } = fakeTransport(() => okGenerate("ok"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    await expect(
      p.complete({ model: "mystery/some-model", messages: [{ role: "user", content: "q" }] }),
    ).rejects.toMatchObject({ category: "model_not_found" });
    expect(calls).toHaveLength(0);
  });

  it("throws model_not_found for an unprefixed model id", async () => {
    const { transport } = fakeTransport(() => okGenerate("ok"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    await expect(
      p.complete({ model: "gpt-4o", messages: [{ role: "user", content: "q" }] }),
    ).rejects.toMatchObject({ category: "model_not_found" });
  });

  it("honors a per-vendor baseUrl override", async () => {
    const { transport, calls } = fakeTransport(() => okGenerate("ok"));
    const p = new VercelAiProvider({
      apiKey: KEY,
      transport,
      baseUrls: { openai: "https://gateway.internal/openai" },
    });
    await p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] });
    expect(calls[0]!.url).toBe("https://gateway.internal/openai");
  });

  it("normalizes usage from inputTokens/outputTokens", async () => {
    const { transport } = fakeTransport(() => okGenerate("answer"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it("falls back to promptTokens/completionTokens usage shape", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: { text: "a", usage: { promptTokens: 5, completionTokens: 3 }, finishReason: "stop" },
    }));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it("uses generateObject's parsed object for structuredOutput when present", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: { text: "", object: { verdict: "no" }, usage: {}, finishReason: "stop" },
    }));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      responseSchema: { type: "object" },
    });
    expect(result.structuredOutput).toEqual({ verdict: "no" });
  });

  it("parses text into structuredOutput when no object field is present", async () => {
    const { transport } = fakeTransport(() => okGenerate('{"verdict":"yes"}'));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      responseSchema: { type: "object" },
    });
    expect(result.structuredOutput).toEqual({ verdict: "yes" });
  });

  it("throws schema_violation when responseSchema requested but text is not JSON", async () => {
    const { transport } = fakeTransport(() => okGenerate("plain prose"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    await expect(
      p.complete({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "q" }],
        responseSchema: { type: "object" },
      }),
    ).rejects.toMatchObject({ category: "schema_violation" });
  });

  it("maps content-filter finishReason to refusal", async () => {
    const { transport } = fakeTransport(() => okGenerate("", "content-filter"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "google/gemini-2.5-pro",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.finishReason).toBe("refusal");
  });

  it("maps error finishReason to error", async () => {
    const { transport } = fakeTransport(() => okGenerate("", "error"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.finishReason).toBe("error");
  });

  it("serializes tool-result messages in AI SDK shape", async () => {
    const { transport, calls } = fakeTransport(() => okGenerate("ok"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    await p.complete({
      model: "openai/gpt-4o",
      messages: [
        { role: "user", content: "x" },
        { role: "tool", content: "7", toolName: "calc", toolCallId: "tc-2" },
      ],
    });
    const wire = (calls[0]!.body as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    expect(wire[1]).toMatchObject({ role: "tool", toolCallId: "tc-2", toolName: "calc" });
  });
});

describe("VercelAiProvider — EC-4 error categories", () => {
  it("throws authentication on a short key without a network call", async () => {
    const { transport, calls } = fakeTransport(() => okGenerate("x"));
    const p = new VercelAiProvider({ apiKey: "short", transport });
    await expect(
      p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] }),
    ).rejects.toMatchObject({ category: "authentication" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, "authentication"],
    [404, "model_not_found"],
    [429, "rate_limit"],
    [504, "network_timeout"],
    [500, "unknown"],
  ] as const)("maps HTTP %i to category %s", async (status, category) => {
    const { transport } = fakeTransport(() => ({ status, json: { error: { message: "x" } } }));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    await expect(
      p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] }),
    ).rejects.toMatchObject({ category });
  });

  it("maps an aborted transport throw to network_timeout", async () => {
    const transport: Transport = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    await expect(
      p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] }),
    ).rejects.toMatchObject({ category: "network_timeout" });
  });

  it("maps a generic transport throw to unknown", async () => {
    const transport: Transport = async () => {
      throw new Error("dns failure");
    };
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const err = await p
      .complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] })
      .catch((e: unknown) => e);
    expect(isProviderError(err)).toBe(true);
    expect((err as { category: string }).category).toBe("unknown");
  });
});

describe("VercelAiProvider.completeStream — EC-2 streaming", () => {
  it("yields a text_delta then a finish chunk", async () => {
    const { transport } = fakeTransport(() => okGenerate("streamed"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const chunks = [];
    for await (const c of p.completeStream({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    })) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ type: "text_delta", delta: "streamed" });
    expect(chunks[1]!.type).toBe("finish");
  });

  it("omits the text_delta on empty text", async () => {
    const { transport } = fakeTransport(() => okGenerate(""));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const chunks = [];
    for await (const c of p.completeStream({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    })) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
  });
});

describe("VercelAiProvider.callTool — EC-3 tool calling", () => {
  it("normalizes an AI SDK toolCalls array into a ToolCallResult", async () => {
    const { transport, calls } = fakeTransport(() => ({
      status: 200,
      json: {
        text: "",
        toolCalls: [{ toolCallId: "tc-7", toolName: "lookup", args: { q: "x" } }],
        usage: { inputTokens: 2, outputTokens: 6 },
        finishReason: "tool-calls",
      },
    }));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "anthropic/claude-sonnet-4",
      messages: [{ role: "user", content: "look it up" }],
      tools: [{ name: "lookup", description: "find", inputSchema: { type: "object" } }],
    });
    expect(result.toolName).toBe("lookup");
    expect(result.toolArguments).toEqual({ q: "x" });
    expect(result.toolCallId).toBe("tc-7");
    expect(result.finishReason).toBe("tool_use");
    // Tools are sent as a record keyed by tool name (AI SDK shape).
    const tools = (calls[0]!.body as Record<string, unknown>).tools as Record<string, unknown>;
    expect(tools.lookup).toBeDefined();
  });

  it("returns null tool fields when the model declines", async () => {
    const { transport } = fakeTransport(() => okGenerate("no tool"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "lookup", description: "find", inputSchema: { type: "object" } }],
    });
    expect(result.toolName).toBeNull();
    expect(result.toolArguments).toBeNull();
    expect(result.text).toBe("no tool");
  });

  it("parses string tool args", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: {
        text: "",
        toolCalls: [{ toolCallId: "tc-1", toolName: "x", args: '{"a":1}' }],
        usage: {},
        finishReason: "tool-calls",
      },
    }));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "x", description: "d", inputSchema: {} }],
    });
    expect(result.toolArguments).toEqual({ a: 1 });
  });

  it("throws authentication on short key in callTool", async () => {
    const { transport } = fakeTransport(() => okGenerate("x"));
    const p = new VercelAiProvider({ apiKey: "tiny", transport });
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
      status: 401,
      json: { error: { message: "bad key" } },
    }));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    await expect(
      p.callTool({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "q" }],
        tools: [{ name: "t", description: "d", inputSchema: {} }],
      }),
    ).rejects.toMatchObject({ category: "authentication" });
  });
});

describe("VercelAiProvider.batch — EC-5 concurrent batching", () => {
  it("returns results in order and per-request errors in-band", async () => {
    const transport: Transport = async (req) => {
      const body = req.body as Record<string, unknown>;
      if (body.model === "nope") return { status: 429, json: { error: { message: "limit" } } };
      return okGenerate(`ok:${String(body.model)}`);
    };
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const reqs: CompletionRequest[] = [
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "1" }] },
      { model: "openai/nope", messages: [{ role: "user", content: "2" }] },
    ];
    const results = await p.batch(reqs);
    expect((results[0] as { text: string }).text).toBe("ok:gpt-4o");
    expect(isProviderError(results[1])).toBe(true);
    expect((results[1] as { category: string }).category).toBe("rate_limit");
  });

  it("captures an unknown-vendor routing error in-band", async () => {
    const { transport } = fakeTransport(() => okGenerate("ok"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const results = await p.batch([
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "a" }] },
      { model: "weird/x", messages: [{ role: "user", content: "b" }] },
    ]);
    expect((results[0] as { text: string }).text).toBe("ok");
    expect(isProviderError(results[1])).toBe(true);
    expect((results[1] as { category: string }).category).toBe("model_not_found");
  });
});

describe("VercelAiProvider — normalization edge cases (branch coverage)", () => {
  it("defaults unknown finishReason to stop", async () => {
    const { transport } = fakeTransport(() => okGenerate("x", "mystery"));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.finishReason).toBe("stop");
  });

  it("treats a missing text field as empty and missing usage as zero", async () => {
    const { transport } = fakeTransport(() => ({ status: 200, json: { finishReason: "stop" } }));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.complete({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.text).toBe("");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('coerces a non-object string tool arg (e.g. "5") to an empty object', async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: {
        text: "",
        toolCalls: [{ toolCallId: "tc-1", toolName: "x", args: "5" }],
        usage: {},
        finishReason: "tool-calls",
      },
    }));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "x", description: "d", inputSchema: {} }],
    });
    expect(result.toolArguments).toEqual({});
  });

  it("returns null tool args when args is absent", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: {
        text: "",
        toolCalls: [{ toolCallId: "tc-1", toolName: "x" }],
        usage: {},
        finishReason: "tool-calls",
      },
    }));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "x", description: "d", inputSchema: {} }],
    });
    expect(result.toolArguments).toBeNull();
  });

  it("coerces a malformed string tool arg to an empty object", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      json: {
        text: "",
        toolCalls: [{ toolCallId: "tc-1", toolName: "x", args: "{not json" }],
        usage: {},
        finishReason: "tool-calls",
      },
    }));
    const p = new VercelAiProvider({ apiKey: KEY, transport });
    const result = await p.callTool({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "x", description: "d", inputSchema: {} }],
    });
    expect(result.toolArguments).toEqual({});
  });
});

describe("VercelAiProvider — CISO gates (PB-7 § 6)", () => {
  it("PASSES G-1 credential redaction", async () => {
    const testKey = "sk-test-G1-vercel-" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    const result = await runCisoGateG1({
      testKey,
      invokeProvider: async () => {
        const { transport } = fakeTransport(() => okGenerate("clean response"));
        const p = new VercelAiProvider({ apiKey: testKey, transport });
        await p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] });
      },
    });
    expect(result.pass).toBe(true);
  });

  it("PASSES G-2 env-var spillover (spawns no subprocess)", async () => {
    const testKey = "sk-test-G2-vercel-" + "z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4";
    const prev = process.env.VERCEL_TEST_KEY;
    process.env.VERCEL_TEST_KEY = testKey;
    try {
      const result = await runCisoGateG2({
        testKey,
        invokeProvider: async () => {
          const { transport } = fakeTransport(() => okGenerate("clean response"));
          const p = new VercelAiProvider({ apiKey: testKey, transport });
          await p.complete({ model: "openai/gpt-4o", messages: [{ role: "user", content: "q" }] });
        },
      });
      expect(result.pass).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.VERCEL_TEST_KEY;
      else process.env.VERCEL_TEST_KEY = prev;
    }
  });
});
