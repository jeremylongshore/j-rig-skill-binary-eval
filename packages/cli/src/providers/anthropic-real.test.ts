import { describe, it, expect } from "vitest";
import { isProviderError } from "@j-rig/core";
import type { Provider } from "@j-rig/core";
import {
  RealAnthropicProvider,
  resolveAnthropicModel,
  AnthropicTriggerProvider,
  AnthropicExecutionProvider,
  AnthropicJudgeProvider,
} from "./anthropic-real.js";
import type { Transport, TransportRequest, TransportResponse } from "./transport.js";

const KEY = "sk-ant-test-0123456789";

/**
 * Fake transport: records the last request and returns a canned Anthropic
 * Messages-API response. No network, no live key — the real adapter's wire
 * format + normalization are exercised deterministically (same discipline as
 * the litellm/vercel prototype tests).
 */
function fakeTransport(response: TransportResponse): {
  transport: Transport;
  lastRequest: () => TransportRequest | undefined;
} {
  let last: TransportRequest | undefined;
  const transport: Transport = async (req) => {
    last = req;
    return response;
  };
  return { transport, lastRequest: () => last };
}

/** A minimal well-formed Anthropic Messages-API text response. */
function textResponse(text: string, stopReason = "end_turn"): TransportResponse {
  return {
    status: 200,
    json: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

describe("resolveAnthropicModel", () => {
  it("maps short aliases to concrete model ids", () => {
    expect(resolveAnthropicModel("sonnet")).toMatch(/^claude-sonnet/);
    expect(resolveAnthropicModel("haiku")).toMatch(/^claude-haiku/);
    expect(resolveAnthropicModel("opus")).toMatch(/^claude-opus/);
  });

  it("strips an anthropic/ prefix before alias lookup", () => {
    expect(resolveAnthropicModel("anthropic/sonnet")).toMatch(/^claude-sonnet/);
  });

  it("passes a fully-qualified claude- id through unchanged", () => {
    expect(resolveAnthropicModel("claude-sonnet-4-5-20990101")).toBe("claude-sonnet-4-5-20990101");
  });

  it("passes an unknown alias through unchanged (no silent rewrite)", () => {
    expect(resolveAnthropicModel("gpt-4o")).toBe("gpt-4o");
  });
});

describe("RealAnthropicProvider.complete — wire format", () => {
  it("POSTs the real Messages API shape with x-api-key + anthropic-version headers", async () => {
    const { transport, lastRequest } = fakeTransport(textResponse("hello world"));
    const provider = new RealAnthropicProvider({ apiKey: KEY, transport });

    const result = await provider.complete({
      model: "sonnet",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "say hi" },
      ],
      maxTokens: 64,
    });

    const req = lastRequest()!;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/v1/messages");
    expect(req.headers["x-api-key"]).toBe(KEY);
    expect(req.headers["anthropic-version"]).toBeDefined();
    // The Anthropic API carries the system prompt at the top level, not as a
    // role:system message.
    const body = req.body as Record<string, unknown>;
    expect(body.system).toBe("You are terse.");
    expect(body.model).toMatch(/^claude-sonnet/);
    expect(body.max_tokens).toBe(64);
    expect(Array.isArray(body.messages)).toBe(true);
    expect((body.messages as unknown[]).length).toBe(1); // only the user turn

    // Response normalization.
    expect(result.text).toBe("hello world");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  it("concatenates multiple text content blocks", async () => {
    const resp: TransportResponse = {
      status: 200,
      json: {
        content: [
          { type: "text", text: "part1 " },
          { type: "text", text: "part2" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    const { transport } = fakeTransport(resp);
    const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const result = await provider.complete({
      model: "sonnet",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.text).toBe("part1 part2");
  });

  it("maps stop_reason=max_tokens to finishReason=length", async () => {
    const { transport } = fakeTransport(textResponse("truncated", "max_tokens"));
    const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const result = await provider.complete({
      model: "sonnet",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.finishReason).toBe("length");
  });

  it("does not log or echo the api key in returned values", async () => {
    const { transport } = fakeTransport(textResponse("ok"));
    const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const result = await provider.complete({
      model: "sonnet",
      messages: [{ role: "user", content: "x" }],
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("RealAnthropicProvider.complete — error categorization", () => {
  it("throws an authentication ProviderError on 401", async () => {
    const { transport } = fakeTransport({ status: 401, json: { error: { message: "bad key" } } });
    const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    await expect(
      provider.complete({ model: "sonnet", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ category: "authentication" });
  });

  it("throws a rate_limit ProviderError on 429", async () => {
    const { transport } = fakeTransport({ status: 429, json: { error: { message: "slow down" } } });
    const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    await expect(
      provider.complete({ model: "sonnet", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ category: "rate_limit" });
  });

  it("throws an authentication error before any network call when the key is too short", async () => {
    let called = false;
    const transport: Transport = async () => {
      called = true;
      return textResponse("x");
    };
    const provider = new RealAnthropicProvider({ apiKey: "short", transport });
    await expect(
      provider.complete({ model: "sonnet", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toSatisfy((e: unknown) => isProviderError(e) && e.category === "authentication");
    expect(called).toBe(false);
  });
});

describe("RealAnthropicProvider.callTool", () => {
  it("normalizes a tool_use content block into a ToolCallResult", async () => {
    const resp: TransportResponse = {
      status: 200,
      json: {
        content: [{ type: "tool_use", id: "tu_1", name: "search", input: { q: "cats" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    };
    const { transport, lastRequest } = fakeTransport(resp);
    const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const result = await provider.callTool({
      model: "sonnet",
      messages: [{ role: "user", content: "find cats" }],
      tools: [{ name: "search", description: "search", inputSchema: { type: "object" } }],
    });
    expect(result.toolName).toBe("search");
    expect(result.toolArguments).toEqual({ q: "cats" });
    expect(result.toolCallId).toBe("tu_1");
    // Tools are sent in the Anthropic input_schema shape.
    const body = lastRequest()!.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]!.input_schema).toEqual({ type: "object" });
  });
});

describe("AnthropicTriggerProvider", () => {
  it("parses a JSON selection from the model output", async () => {
    const { transport } = fakeTransport(
      textResponse('{"selected": "commit-writer", "reasoning": "user asked for a commit message"}'),
    );
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const trig = new AnthropicTriggerProvider("sonnet", provider);
    const out = await trig.selectSkill("write a commit message", [
      { name: "commit-writer", description: "writes commits" },
    ]);
    expect(out.selected).toBe("commit-writer");
    expect(out.reasoning).toContain("commit message");
  });

  it("returns null when the model selects null", async () => {
    const { transport } = fakeTransport(
      textResponse('{"selected": "null", "reasoning": "no fit"}'),
    );
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const trig = new AnthropicTriggerProvider("sonnet", provider);
    const out = await trig.selectSkill("unrelated", [{ name: "x", description: "y" }]);
    expect(out.selected).toBeNull();
  });

  it("tolerates a markdown-fenced JSON object", async () => {
    const { transport } = fakeTransport(
      textResponse('```json\n{"selected":"x","reasoning":"r"}\n```'),
    );
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const trig = new AnthropicTriggerProvider("sonnet", provider);
    const out = await trig.selectSkill("p", [{ name: "x", description: "y" }]);
    expect(out.selected).toBe("x");
  });
});

describe("AnthropicExecutionProvider", () => {
  it("runs the skill body as the system prompt and captures real output", async () => {
    const { transport, lastRequest } = fakeTransport(textResponse("feat: rename file"));
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const exec = new AnthropicExecutionProvider("sonnet", provider);
    const out = await exec.execute(
      "write a commit message",
      { skill_body: "# Commit Writer\nProduce conventional commits." },
      {},
    );
    expect(out.text).toBe("feat: rename file");
    expect(out.meta.timed_out).toBe(false);
    expect(out.meta.duration_ms).toBeGreaterThanOrEqual(0);
    const body = lastRequest()!.body as Record<string, unknown>;
    expect(body.system).toContain("Commit Writer");
  });
});

describe("AnthropicJudgeProvider", () => {
  it("parses a binary verdict from the judge model", async () => {
    const { transport } = fakeTransport(
      textResponse('{"verdict": "yes", "confidence": 0.9, "reasoning": "matches"}'),
    );
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const judge = new AnthropicJudgeProvider("sonnet", provider);
    const out = await judge.judge("Output is a conventional commit", "p", "feat: x");
    expect(out.verdict).toBe("yes");
    expect(out.confidence).toBeCloseTo(0.9);
  });

  it("recovers the verdict from a JSON object truncated past the token ceiling", async () => {
    // Verbose reasoning can blow the token budget, leaving the JSON object
    // unterminated; parseJsonObject() returns null but the verdict token is
    // still recoverable via the regex fallback. Before the fix this dropped to
    // "unsure" and inflated NO-SHIP rates.
    const truncated =
      '{"verdict": "no", "confidence": 0.95, "reasoning": "The output writes to the account without the required';
    const { transport } = fakeTransport(textResponse(truncated, "max_tokens"));
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const judge = new AnthropicJudgeProvider("sonnet", provider);
    const out = await judge.judge("requires confirmation before a write", "p", "o");
    expect(out.verdict).toBe("no");
  });

  it("maps an unrecognized verdict to 'unsure'", async () => {
    const { transport } = fakeTransport(textResponse('{"verdict": "maybe", "confidence": 0.5}'));
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const judge = new AnthropicJudgeProvider("sonnet", provider);
    const out = await judge.judge("c", "p", "o");
    expect(out.verdict).toBe("unsure");
  });

  it("clamps an out-of-range confidence into [0,1]", async () => {
    const { transport } = fakeTransport(textResponse('{"verdict": "no", "confidence": 5}'));
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const judge = new AnthropicJudgeProvider("sonnet", provider);
    const out = await judge.judge("c", "p", "o");
    expect(out.confidence).toBe(1);
  });

  it("honors timeout_ms: a hung endpoint aborts and rejects as network_timeout", async () => {
    // A judge call carried NO timeout before this option (observed live: a
    // NIM endpoint hung a judge call for over an hour). The transport below
    // never resolves until the abort signal fires — the call must reject.
    const transport: Transport = (req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const judge = new AnthropicJudgeProvider("sonnet", provider);
    await expect(judge.judge("c", "p", "o", undefined, { timeout_ms: 10 })).rejects.toMatchObject({
      category: "network_timeout",
    });
  });

  it("threads the abort signal on timeout_ms and clears the timer on success", async () => {
    const { transport, lastRequest } = fakeTransport(
      textResponse('{"verdict": "yes", "confidence": 1, "reasoning": "r"}'),
    );
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const judge = new AnthropicJudgeProvider("sonnet", provider);
    const out = await judge.judge("c", "p", "o", undefined, { timeout_ms: 5000 });
    expect(out.verdict).toBe("yes");
    expect(lastRequest()!.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes no signal when no timeout is configured (legacy call shape)", async () => {
    const { transport, lastRequest } = fakeTransport(
      textResponse('{"verdict": "yes", "confidence": 1, "reasoning": "r"}'),
    );
    const provider: Provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const judge = new AnthropicJudgeProvider("sonnet", provider);
    await judge.judge("c", "p", "o");
    expect(lastRequest()!.signal).toBeUndefined();
  });

  it("passes no signal for invalid non-positive or non-finite direct timeout values", async () => {
    for (const timeout_ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { transport, lastRequest } = fakeTransport(
        textResponse('{"verdict": "yes", "confidence": 1, "reasoning": "r"}'),
      );
      const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
      const judge = new AnthropicJudgeProvider("sonnet", provider);

      await judge.judge("c", "p", "o", undefined, { timeout_ms });

      expect(lastRequest()!.signal).toBeUndefined();
    }
  });
});

/** Await a promise expected to reject and return the rejection. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

function throwingTransport(err: unknown): Transport {
  return async () => {
    throw err;
  };
}

const USER = [{ role: "user" as const, content: "q" }];

describe("RealAnthropicProvider — fail-closed error categorization (all statuses)", () => {
  it("maps every non-2xx status to its category and falls back to a generic message", async () => {
    const cases: Array<[number, string]> = [
      [403, "authentication"],
      [404, "model_not_found"],
      [408, "network_timeout"],
      [504, "network_timeout"],
      [529, "network_timeout"],
      [500, "unknown"],
      [302, "unknown"],
    ];
    for (const [status, category] of cases) {
      const { transport } = fakeTransport({ status, json: null });
      const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
      const err = await rejection(provider.complete({ model: "sonnet", messages: USER }));
      expect(isProviderError(err)).toBe(true);
      expect(err).toMatchObject({ category, providerName: "anthropic" });
      expect((err as Error).message).toBe(`Anthropic API returned HTTP ${status}`);
    }
  });

  it("classifies a thrown AbortError or timeout message as network_timeout", async () => {
    const abort = Object.assign(new Error("the operation was cancelled"), { name: "AbortError" });
    for (const thrown of [abort, new Error("socket timeout after 30s")]) {
      const provider = new RealAnthropicProvider({
        apiKey: KEY,
        transport: throwingTransport(thrown),
      });
      const err = await rejection(provider.complete({ model: "sonnet", messages: USER }));
      expect(err).toMatchObject({ category: "network_timeout", originalError: thrown });
    }
  });

  it("classifies any other thrown value as unknown and keeps an already-categorized error", async () => {
    const generic = new RealAnthropicProvider({
      apiKey: KEY,
      transport: throwingTransport("ECONNRESET"),
    });
    const err = await rejection(generic.complete({ model: "sonnet", messages: USER }));
    expect(err).toMatchObject({ category: "unknown", message: "ECONNRESET" });

    const refusal = new RealAnthropicProvider({
      apiKey: KEY,
      transport: throwingTransport(new Error("dns lookup failed")),
    });
    expect(await rejection(refusal.complete({ model: "sonnet", messages: USER }))).toMatchObject({
      category: "unknown",
      message: "dns lookup failed",
    });

    const original = await rejection(
      new RealAnthropicProvider({
        apiKey: KEY,
        transport: async () => ({ status: 429, json: { error: { message: "slow down" } } }),
      }).complete({ model: "sonnet", messages: USER }),
    );
    const passthrough = new RealAnthropicProvider({
      apiKey: KEY,
      transport: throwingTransport(original),
    });
    expect(await rejection(passthrough.complete({ model: "sonnet", messages: USER }))).toBe(
      original,
    );
  });

  it("refuses a too-short key on callTool before any network call", async () => {
    let called = false;
    const provider = new RealAnthropicProvider({
      apiKey: "short",
      transport: async () => {
        called = true;
        return textResponse("x");
      },
    });
    const err = await rejection(provider.callTool({ model: "sonnet", messages: USER, tools: [] }));
    expect(err).toMatchObject({ category: "authentication" });
    expect(called).toBe(false);
  });
});

describe("RealAnthropicProvider — response normalization edges", () => {
  it("maps each stop_reason, defaulting an unknown one to stop", async () => {
    const expected: Array<[unknown, string]> = [
      ["stop_sequence", "stop"],
      ["tool_use", "tool_use"],
      ["refusal", "refusal"],
      ["something_new", "stop"],
      [undefined, "stop"],
    ];
    for (const [stopReason, finishReason] of expected) {
      const { transport } = fakeTransport({
        status: 200,
        json: { content: [{ type: "text", text: "t" }], stop_reason: stopReason },
      });
      const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
      const result = await provider.complete({ model: "sonnet", messages: USER });
      expect(result.finishReason).toBe(finishReason);
    }
  });

  it("zeroes missing usage, keeps cached input tokens, and ignores non-text or malformed blocks", async () => {
    const { transport } = fakeTransport({
      status: 200,
      json: {
        content: [
          null,
          { type: "tool_use" },
          { type: "text", text: 7 },
          { type: "text", text: "ok" },
        ],
        usage: { input_tokens: "many", cache_read_input_tokens: 4 },
      },
    });
    const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const result = await provider.complete({ model: "sonnet", messages: USER });
    expect(result.text).toBe("ok");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 4 });

    const { transport: noContent } = fakeTransport({ status: 200, json: { content: "none" } });
    const empty = await new RealAnthropicProvider({ apiKey: KEY, transport: noContent }).complete({
      model: "sonnet",
      messages: USER,
    });
    expect(empty.text).toBe("");
    expect(empty.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("sends tool results as user tool_result blocks and forwards temperature and stop sequences", async () => {
    const { transport, lastRequest } = fakeTransport(textResponse("done"));
    const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    await provider.complete({
      model: "claude-haiku-4-5-20251001",
      messages: [
        { role: "user", content: "call it" },
        { role: "tool", content: "42", toolCallId: "tool-1" },
        { role: "tool", content: "43" },
      ],
      temperature: 0.2,
      stop: ["END"],
    });
    const body = lastRequest()!.body as Record<string, unknown>;
    expect(body.system).toBeUndefined();
    expect(body.temperature).toBe(0.2);
    expect(body.stop_sequences).toEqual(["END"]);
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([
      { role: "user", content: "call it" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "42" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "", content: "43" }] },
    ]);
  });

  it("parses structured output when a responseSchema is requested and refuses non-JSON text", async () => {
    const ok = new RealAnthropicProvider({
      apiKey: KEY,
      transport: fakeTransport(textResponse('{"a":1}')).transport,
    });
    const parsed = await ok.complete({ model: "sonnet", messages: USER, responseSchema: {} });
    expect(parsed.structuredOutput).toEqual({ a: 1 });

    const bad = new RealAnthropicProvider({
      apiKey: KEY,
      transport: fakeTransport(textResponse("not json")).transport,
    });
    const err = await rejection(
      bad.complete({ model: "sonnet", messages: USER, responseSchema: {} }),
    );
    expect(err).toMatchObject({ category: "schema_violation" });
  });

  it("streams a text delta then a finish chunk, and only a finish chunk for empty text", async () => {
    const collect = async (text: string) => {
      const provider = new RealAnthropicProvider({
        apiKey: KEY,
        transport: fakeTransport(textResponse(text)).transport,
      });
      const chunks: unknown[] = [];
      for await (const chunk of provider.completeStream({ model: "sonnet", messages: USER })) {
        chunks.push(chunk);
      }
      return chunks;
    };
    expect(await collect("hi")).toEqual([
      { type: "text_delta", delta: "hi" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    expect(await collect("")).toEqual([
      { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it("returns per-request errors from batch instead of rejecting the whole batch", async () => {
    let call = 0;
    const provider = new RealAnthropicProvider({
      apiKey: KEY,
      transport: async () => {
        call += 1;
        if (call === 2) return { status: 401, json: { error: { message: "bad key" } } };
        return textResponse(`answer-${call}`);
      },
    });
    const results = await provider.batch([
      { model: "sonnet", messages: USER },
      { model: "sonnet", messages: USER },
    ]);
    expect(results[0]).toMatchObject({ text: "answer-1" });
    expect(isProviderError(results[1])).toBe(true);
    expect(results[1]).toMatchObject({ category: "authentication", message: "bad key" });
  });
});

describe("RealAnthropicProvider.callTool — degenerate responses", () => {
  const tools = [{ name: "lookup", description: "d", inputSchema: { type: "object" } }];

  it("throws a categorized error on a non-2xx tool call", async () => {
    const provider = new RealAnthropicProvider({
      apiKey: KEY,
      transport: fakeTransport({ status: 404, json: {} }).transport,
    });
    const err = await rejection(
      provider.callTool({
        model: "sonnet",
        messages: [{ role: "system", content: "s" }, ...USER],
        tools,
      }),
    );
    expect(err).toMatchObject({ category: "model_not_found" });
  });

  it("returns a null tool call with the text when the model answered without a tool", async () => {
    const provider = new RealAnthropicProvider({
      apiKey: KEY,
      transport: fakeTransport(textResponse("no tool needed", "end_turn")).transport,
    });
    const result = await provider.callTool({ model: "sonnet", messages: USER, tools });
    expect(result).toEqual({
      toolName: null,
      toolArguments: null,
      toolCallId: null,
      text: "no tool needed",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("refuses malformed tool_use fields and tolerates a null body", async () => {
    const malformed = new RealAnthropicProvider({
      apiKey: KEY,
      transport: fakeTransport({
        status: 200,
        json: { content: [{ type: "tool_use", name: 1, input: "args", id: 2 }] },
      }).transport,
    });
    await expect(
      malformed.callTool({ model: "sonnet", messages: USER, tools }),
    ).rejects.toMatchObject({
      category: "schema_violation",
      message: "invalid_tool_call",
    });

    const empty = new RealAnthropicProvider({
      apiKey: KEY,
      transport: fakeTransport({ status: 200, json: null }).transport,
    });
    expect(await empty.callTool({ model: "sonnet", messages: USER, tools })).toMatchObject({
      toolName: null,
      text: "",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});

describe("Anthropic eval bridges — unparseable model output", () => {
  it("trigger: falls back to raw text reasoning and null selection when no JSON is returned", async () => {
    const provider = new RealAnthropicProvider({
      apiKey: KEY,
      transport: fakeTransport(textResponse("I would not pick any skill here.")).transport,
    });
    const trigger = new AnthropicTriggerProvider("sonnet", provider);
    expect(await trigger.selectSkill("p", [{ name: "a", description: "b" }])).toEqual({
      selected: null,
      reasoning: "I would not pick any skill here.",
    });
  });

  it("trigger: treats the string 'null' and an empty name as no selection", async () => {
    for (const selected of ['"null"', '""', "42"]) {
      const provider = new RealAnthropicProvider({
        apiKey: KEY,
        transport: fakeTransport(textResponse(`{"selected": ${selected}, "reasoning": "r"}`))
          .transport,
      });
      const trigger = new AnthropicTriggerProvider("sonnet", provider);
      expect((await trigger.selectSkill("p", [])).selected).toBeNull();
    }
  });

  it("judge: defaults confidence to 0.5 and uses raw text when fields are missing or a scalar parses", async () => {
    for (const text of ['{"verdict": "no", "confidence": "high"}', "{} trailing } but [1]"]) {
      const provider = new RealAnthropicProvider({
        apiKey: KEY,
        transport: fakeTransport(textResponse(text)).transport,
      });
      const judge = new AnthropicJudgeProvider("sonnet", provider);
      const out = await judge.judge("c", "p", "o", "custom question?");
      expect(out.confidence).toBe(0.5);
      expect(out.reasoning).toBe(text.slice(0, 200));
    }
  });

  it("execution: forwards a model override, temperature, and a timeout signal", async () => {
    const { transport, lastRequest } = fakeTransport(textResponse("executed"));
    const provider = new RealAnthropicProvider({ apiKey: KEY, transport });
    const execution = new AnthropicExecutionProvider("sonnet", provider);
    const out = await execution.execute(
      "prompt",
      { skill_body: "body" } as Parameters<AnthropicExecutionProvider["execute"]>[1],
      { model: "haiku", temperature: 0, timeout_ms: 5_000 },
    );
    expect(out.text).toBe("executed");
    expect(out.meta.timed_out).toBe(false);
    const request = lastRequest()!;
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const body = request.body as Record<string, unknown>;
    expect(body.model).toMatch(/^claude-haiku/);
    expect(body.temperature).toBe(0);
  });
});
