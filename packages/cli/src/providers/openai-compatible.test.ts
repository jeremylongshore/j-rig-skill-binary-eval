import { describe, it, expect } from "vitest";
import { isProviderError } from "@j-rig/core";
import type { Provider } from "@j-rig/core";
import {
  RealOpenAICompatProvider,
  OpenAICompatTriggerProvider,
  OpenAICompatExecutionProvider,
  OpenAICompatJudgeProvider,
  resolveOpenAICompatConfig,
  PROVIDER_PRESETS,
} from "./openai-compatible.js";
import type { Transport, TransportRequest, TransportResponse } from "./transport.js";

const KEY = "sk-test-0123456789abcdef";
const BASE = "https://api.deepseek.com";

/**
 * Fake transport: records the last request and returns a canned OpenAI
 * Chat-Completions response. No network, no live key — the adapter's wire
 * format + normalization are exercised deterministically.
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

/** A minimal well-formed OpenAI Chat-Completions text response. */
function textResponse(text: string, finishReason = "stop"): TransportResponse {
  return {
    status: 200,
    json: {
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [
        { index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  };
}

describe("resolveOpenAICompatConfig", () => {
  it("returns null when no compatible key is present", () => {
    expect(resolveOpenAICompatConfig({})).toBeNull();
  });

  it("selects the deepseek preset from DEEPSEEK_API_KEY", () => {
    const cfg = resolveOpenAICompatConfig({ DEEPSEEK_API_KEY: KEY });
    expect(cfg).not.toBeNull();
    expect(cfg!.name).toBe("deepseek");
    expect(cfg!.baseUrl).toBe(PROVIDER_PRESETS.deepseek!.baseUrl);
    expect(cfg!.defaultModel).toBe(PROVIDER_PRESETS.deepseek!.defaultModel);
    expect(cfg!.apiKey).toBe(KEY);
  });

  it("prefers deepseek over kimi and openrouter when several keys are set", () => {
    const cfg = resolveOpenAICompatConfig({
      DEEPSEEK_API_KEY: KEY,
      MOONSHOT_API_KEY: KEY,
      OPENROUTER_API_KEY: KEY,
    });
    expect(cfg!.name).toBe("deepseek");
  });

  it("selects kimi when only MOONSHOT_API_KEY is set", () => {
    const cfg = resolveOpenAICompatConfig({ MOONSHOT_API_KEY: KEY });
    expect(cfg!.name).toBe("kimi");
    expect(cfg!.baseUrl).toContain("moonshot");
  });

  it("selects openrouter when only OPENROUTER_API_KEY is set", () => {
    const cfg = resolveOpenAICompatConfig({ OPENROUTER_API_KEY: KEY });
    expect(cfg!.name).toBe("openrouter");
    expect(cfg!.baseUrl).toContain("openrouter");
  });

  it("honors an explicit --provider preference (kimi) over the default order", () => {
    const cfg = resolveOpenAICompatConfig({ DEEPSEEK_API_KEY: KEY, MOONSHOT_API_KEY: KEY }, "kimi");
    expect(cfg!.name).toBe("kimi");
  });

  it("treats moonshot as an alias for kimi", () => {
    const cfg = resolveOpenAICompatConfig({ MOONSHOT_API_KEY: KEY }, "moonshot");
    expect(cfg!.name).toBe("kimi");
  });

  it("returns null for an explicit preset whose key is absent (no silent fallthrough)", () => {
    // DeepSeek key IS present, but the operator explicitly asked for kimi —
    // we must NOT quietly route the kimi request to DeepSeek.
    const cfg = resolveOpenAICompatConfig({ DEEPSEEK_API_KEY: KEY }, "kimi");
    expect(cfg).toBeNull();
  });

  it("resolves the generic LLM_* triple", () => {
    const cfg = resolveOpenAICompatConfig({
      LLM_BASE_URL: "https://gw.example.com/v1",
      LLM_MODEL: "some-model",
      LLM_API_KEY: KEY,
      LLM_PROVIDER: "my-gateway",
    });
    expect(cfg!.name).toBe("my-gateway");
    expect(cfg!.baseUrl).toBe("https://gw.example.com/v1");
    expect(cfg!.defaultModel).toBe("some-model");
  });

  it("lets LLM_MODEL override a preset's default model", () => {
    const cfg = resolveOpenAICompatConfig({
      DEEPSEEK_API_KEY: KEY,
      LLM_MODEL: "deepseek-reasoner",
    });
    expect(cfg!.name).toBe("deepseek");
    expect(cfg!.defaultModel).toBe("deepseek-reasoner");
  });

  it("rejects a too-short key", () => {
    expect(resolveOpenAICompatConfig({ DEEPSEEK_API_KEY: "short" })).toBeNull();
  });
});

describe("RealOpenAICompatProvider.complete — wire format", () => {
  it("POSTs the Chat-Completions shape to {base}/chat/completions with a Bearer header", async () => {
    const { transport, lastRequest } = fakeTransport(textResponse("hello world"));
    const provider = new RealOpenAICompatProvider({
      apiKey: KEY,
      baseUrl: BASE,
      name: "deepseek",
      transport,
    });

    const result = await provider.complete({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "say hi" },
      ],
      maxTokens: 64,
    });

    const req = lastRequest()!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/chat/completions`);
    expect(req.headers["authorization"]).toBe(`Bearer ${KEY}`);
    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("deepseek-chat");
    expect(body.max_tokens).toBe(64);
    const msgs = body.messages as Array<Record<string, unknown>>;
    // System stays a role:system message in the OpenAI shape (not hoisted).
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");

    expect(result.text).toBe("hello world");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  it("maps finish_reason=length to finishReason=length", async () => {
    const { transport } = fakeTransport(textResponse("truncated", "length"));
    const provider = new RealOpenAICompatProvider({ apiKey: KEY, baseUrl: BASE, transport });
    const result = await provider.complete({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.finishReason).toBe("length");
  });

  it("strips a trailing slash from the base URL", async () => {
    const { transport, lastRequest } = fakeTransport(textResponse("ok"));
    const provider = new RealOpenAICompatProvider({ apiKey: KEY, baseUrl: `${BASE}/`, transport });
    await provider.complete({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(lastRequest()!.url).toBe(`${BASE}/chat/completions`);
  });

  it("does not echo the api key in returned values", async () => {
    const { transport } = fakeTransport(textResponse("ok"));
    const provider = new RealOpenAICompatProvider({ apiKey: KEY, baseUrl: BASE, transport });
    const result = await provider.complete({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("uses the provider name in error attribution", async () => {
    const { transport } = fakeTransport({ status: 500, json: { error: { message: "boom" } } });
    const provider = new RealOpenAICompatProvider({
      apiKey: KEY,
      baseUrl: BASE,
      name: "deepseek",
      transport,
    });
    await expect(
      provider.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ providerName: "deepseek" });
  });
});

describe("RealOpenAICompatProvider.complete — error categorization", () => {
  it("throws an authentication ProviderError on 401", async () => {
    const { transport } = fakeTransport({ status: 401, json: { error: { message: "bad key" } } });
    const provider = new RealOpenAICompatProvider({ apiKey: KEY, baseUrl: BASE, transport });
    await expect(
      provider.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ category: "authentication" });
  });

  it("throws a rate_limit ProviderError on 429", async () => {
    const { transport } = fakeTransport({ status: 429, json: { error: { message: "slow down" } } });
    const provider = new RealOpenAICompatProvider({ apiKey: KEY, baseUrl: BASE, transport });
    await expect(
      provider.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ category: "rate_limit" });
  });

  it("throws auth before any network call when the key is too short", async () => {
    let called = false;
    const transport: Transport = async () => {
      called = true;
      return textResponse("x");
    };
    const provider = new RealOpenAICompatProvider({ apiKey: "short", baseUrl: BASE, transport });
    await expect(
      provider.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toSatisfy((e: unknown) => isProviderError(e) && e.category === "authentication");
    expect(called).toBe(false);
  });
});

describe("RealOpenAICompatProvider.callTool", () => {
  it("normalizes a tool_calls function into a ToolCallResult", async () => {
    const resp: TransportResponse = {
      status: 200,
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "search", arguments: '{"q":"cats"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
    };
    const { transport, lastRequest } = fakeTransport(resp);
    const provider = new RealOpenAICompatProvider({ apiKey: KEY, baseUrl: BASE, transport });
    const result = await provider.callTool({
      model: "m",
      messages: [{ role: "user", content: "find cats" }],
      tools: [{ name: "search", description: "search", inputSchema: { type: "object" } }],
    });
    expect(result.toolName).toBe("search");
    expect(result.toolArguments).toEqual({ q: "cats" });
    expect(result.toolCallId).toBe("call_1");
    const body = lastRequest()!.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect((tools[0]!.function as Record<string, unknown>).parameters).toEqual({ type: "object" });
  });
});

describe("OpenAICompatTriggerProvider", () => {
  it("parses a JSON selection from the model output", async () => {
    const { transport } = fakeTransport(
      textResponse('{"selected": "commit-writer", "reasoning": "user asked for a commit message"}'),
    );
    const provider: Provider = new RealOpenAICompatProvider({
      apiKey: KEY,
      baseUrl: BASE,
      transport,
    });
    const trig = new OpenAICompatTriggerProvider("deepseek-chat", provider);
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
    const provider: Provider = new RealOpenAICompatProvider({
      apiKey: KEY,
      baseUrl: BASE,
      transport,
    });
    const trig = new OpenAICompatTriggerProvider("m", provider);
    const out = await trig.selectSkill("unrelated", [{ name: "x", description: "y" }]);
    expect(out.selected).toBeNull();
  });

  it("tolerates a markdown-fenced JSON object", async () => {
    const { transport } = fakeTransport(
      textResponse('```json\n{"selected":"x","reasoning":"r"}\n```'),
    );
    const provider: Provider = new RealOpenAICompatProvider({
      apiKey: KEY,
      baseUrl: BASE,
      transport,
    });
    const trig = new OpenAICompatTriggerProvider("m", provider);
    const out = await trig.selectSkill("p", [{ name: "x", description: "y" }]);
    expect(out.selected).toBe("x");
  });
});

describe("OpenAICompatExecutionProvider", () => {
  it("runs the skill body as the system prompt and captures real output", async () => {
    const { transport, lastRequest } = fakeTransport(textResponse("feat: rename file"));
    const provider: Provider = new RealOpenAICompatProvider({
      apiKey: KEY,
      baseUrl: BASE,
      transport,
    });
    const exec = new OpenAICompatExecutionProvider("m", provider);
    const out = await exec.execute(
      "write a commit message",
      { skill_body: "# Commit Writer\nProduce conventional commits." },
      {},
    );
    expect(out.text).toBe("feat: rename file");
    expect(out.meta.timed_out).toBe(false);
    expect(out.meta.duration_ms).toBeGreaterThanOrEqual(0);
    const msgs = (lastRequest()!.body as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    expect(msgs[0]!.content).toContain("Commit Writer");
  });
});

describe("OpenAICompatJudgeProvider", () => {
  it("parses a binary verdict from the judge model", async () => {
    const { transport } = fakeTransport(
      textResponse('{"verdict": "yes", "confidence": 0.9, "reasoning": "matches"}'),
    );
    const provider: Provider = new RealOpenAICompatProvider({
      apiKey: KEY,
      baseUrl: BASE,
      transport,
    });
    const judge = new OpenAICompatJudgeProvider("m", provider);
    const out = await judge.judge("Output is a conventional commit", "p", "feat: x");
    expect(out.verdict).toBe("yes");
    expect(out.confidence).toBeCloseTo(0.9);
  });

  it("maps an unrecognized verdict to 'unsure'", async () => {
    const { transport } = fakeTransport(textResponse('{"verdict": "maybe", "confidence": 0.5}'));
    const provider: Provider = new RealOpenAICompatProvider({
      apiKey: KEY,
      baseUrl: BASE,
      transport,
    });
    const judge = new OpenAICompatJudgeProvider("m", provider);
    const out = await judge.judge("c", "p", "o");
    expect(out.verdict).toBe("unsure");
  });

  it("clamps an out-of-range confidence into [0,1]", async () => {
    const { transport } = fakeTransport(textResponse('{"verdict": "no", "confidence": 5}'));
    const provider: Provider = new RealOpenAICompatProvider({
      apiKey: KEY,
      baseUrl: BASE,
      transport,
    });
    const judge = new OpenAICompatJudgeProvider("m", provider);
    const out = await judge.judge("c", "p", "o");
    expect(out.confidence).toBe(1);
  });
});
