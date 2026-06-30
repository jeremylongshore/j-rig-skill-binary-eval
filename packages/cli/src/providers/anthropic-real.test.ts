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
});
