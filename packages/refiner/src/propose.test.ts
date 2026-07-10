import { describe, it, expect, vi } from "vitest";
import {
  makeSkillDoc,
  NaiveInContextStrategy,
  SkillOptStyleStrategy,
} from "@intentsolutions/refiner-core";
import {
  propose,
  createRefinerModel,
  createCompletionClient,
  resolveProposeModelId,
  assertNotOpus,
  AnthropicCompletionClient,
  OpenAICompatCompletionClient,
  ProposeAdapterError,
  type CompletionClient,
  type CompletionTransport,
} from "./propose.js";
import type { ResolvedProvider } from "./providers.js";

const doc = makeSkillDoc("demo", "# Demo skill\n\nDo the thing carefully and report.\n");

/** A mock CompletionClient: records requests, returns canned op JSON. */
function mockClient(text: string): CompletionClient & { calls: Array<{ model: string }> } {
  const calls: Array<{ model: string }> = [];
  return {
    calls,
    async complete(req): Promise<string> {
      calls.push({ model: req.model });
      return text;
    },
  };
}

const PROPOSAL_JSON =
  '{"rationale":"tighten wording","ops":[{"kind":"replace","target":"carefully","content":"with care"}]}';

describe("tiered routing + no-opus guard (AC-5)", () => {
  it("resolves haiku/sonnet aliases to concrete model ids", () => {
    expect(resolveProposeModelId("haiku")).toBe("claude-haiku-4-5-20251001");
    expect(resolveProposeModelId("sonnet")).toBe("claude-sonnet-4-6");
  });

  it("passes through a fully-qualified non-opus id", () => {
    expect(resolveProposeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("assertNotOpus rejects any opus id", () => {
    expect(() => assertNotOpus("claude-opus-4-1")).toThrow(ProposeAdapterError);
    expect(() => assertNotOpus("OPUS")).toThrow(/final-validation-only/);
  });

  it("resolveProposeModelId refuses an opus id (AC-5: opus is validation-only)", () => {
    expect(() => resolveProposeModelId("claude-opus-4-1")).toThrow(/opus/i);
  });

  it("createRefinerModel records the resolved concrete model id (default sonnet)", () => {
    const model = createRefinerModel(mockClient(PROPOSAL_JSON));
    expect(model.id).toBe("claude-sonnet-4-6");
  });

  it("createRefinerModel honours the haiku tier", () => {
    const model = createRefinerModel(mockClient(PROPOSAL_JSON), { tier: "haiku" });
    expect(model.id).toBe("claude-haiku-4-5-20251001");
  });
});

describe("propose() adapter — wires a RefinerStrategy to a mocked client (step 6)", () => {
  it("routes the completion through the tier model (sonnet) — no live SDK", async () => {
    const client = mockClient(PROPOSAL_JSON);
    const proposal = await propose(new SkillOptStyleStrategy(), { doc, rollouts: [] }, client, {
      tier: "sonnet",
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].model).toBe("claude-sonnet-4-6");
    expect(proposal.refinerModel).toBe("claude-sonnet-4-6");
  });

  it("routes through haiku when asked", async () => {
    const client = mockClient(PROPOSAL_JSON);
    await propose(new NaiveInContextStrategy(), { doc, rollouts: [] }, client, { tier: "haiku" });
    expect(client.calls[0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("produces a proposal anchored to the doc + tagged with the strategy id", async () => {
    const proposal = await propose(
      new SkillOptStyleStrategy(),
      { doc, rollouts: [] },
      mockClient(PROPOSAL_JSON),
    );
    expect(proposal.parent).toBe(doc.hash);
    expect(proposal.refinerStrategyId).toBe("skill-opt-style/v1");
    expect(proposal.ops).toHaveLength(1);
  });

  it("the naive strategy also runs against the mocked client", async () => {
    const proposal = await propose(
      new NaiveInContextStrategy(),
      { doc, rollouts: [] },
      mockClient(PROPOSAL_JSON),
    );
    expect(proposal.refinerStrategyId).toBe("naive-in-context/v1");
  });
});

describe("AnthropicCompletionClient — SDK-free, injectable transport", () => {
  /** Fake transport returning an Anthropic Messages-API success body. */
  function okTransport(text: string): CompletionTransport {
    return async () => ({ status: 200, json: { content: [{ type: "text", text }] } });
  }

  it("posts to the Messages API and extracts text — without a live key/network", async () => {
    const transport = vi.fn(okTransport("hello world"));
    const client = new AnthropicCompletionClient({ apiKey: "test-key-1234", transport });
    const out = await client.complete({ model: "claude-sonnet-4-6", prompt: "hi" });
    expect(out).toBe("hello world");
    expect(transport).toHaveBeenCalledOnce();
    const req = transport.mock.calls[0][0];
    expect(req.url).toContain("/v1/messages");
    expect(req.headers["x-api-key"]).toBe("test-key-1234");
    expect(req.headers["anthropic-version"]).toBeDefined();
  });

  it("refuses a missing/short key before any network call", async () => {
    const transport = vi.fn(okTransport("x"));
    const client = new AnthropicCompletionClient({ apiKey: "short", transport });
    await expect(client.complete({ model: "claude-sonnet-4-6", prompt: "hi" })).rejects.toThrow(
      /apiKey/,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses to send an opus model on the propose path (defense in depth)", async () => {
    const transport = vi.fn(okTransport("x"));
    const client = new AnthropicCompletionClient({ apiKey: "test-key-1234", transport });
    await expect(client.complete({ model: "claude-opus-4-1", prompt: "hi" })).rejects.toThrow(
      /opus/i,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("maps a non-2xx response to a ProposeAdapterError", async () => {
    const transport: CompletionTransport = async () => ({ status: 429, json: {} });
    const client = new AnthropicCompletionClient({ apiKey: "test-key-1234", transport });
    await expect(
      client.complete({ model: "claude-haiku-4-5-20251001", prompt: "hi" }),
    ).rejects.toThrow(/HTTP 429/);
  });

  it("does not leak the key into thrown errors", async () => {
    const transport: CompletionTransport = async () => ({ status: 500, json: {} });
    const client = new AnthropicCompletionClient({ apiKey: "super-secret-key-value", transport });
    await client
      .complete({ model: "claude-haiku-4-5-20251001", prompt: "hi" })
      .catch((e: unknown) => {
        expect(String(e)).not.toContain("super-secret-key-value");
      });
  });
});

describe("OpenAICompatCompletionClient — Chat Completions, SDK-free, injectable transport", () => {
  /** Fake transport returning an OpenAI Chat-Completions success body. */
  function okChatTransport(text: string): CompletionTransport {
    return async () => ({
      status: 200,
      json: { choices: [{ message: { role: "assistant", content: text } }] },
    });
  }

  it("POSTs to {base}/chat/completions with Bearer auth + the OpenAI body shape", async () => {
    const transport = vi.fn(okChatTransport("refined output"));
    const client = new OpenAICompatCompletionClient({
      apiKey: "nvidia-key-1234",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      name: "nvidia",
      transport,
    });
    const out = await client.complete({ model: "meta/llama-3.3-70b-instruct", prompt: "hi" });
    expect(out).toBe("refined output");
    expect(transport).toHaveBeenCalledOnce();
    const req = transport.mock.calls[0][0];
    expect(req.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer nvidia-key-1234");
    const body = req.body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("meta/llama-3.3-70b-instruct");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("strips a trailing slash from the base URL", async () => {
    const transport = vi.fn(okChatTransport("x"));
    const client = new OpenAICompatCompletionClient({
      apiKey: "key-12345678",
      baseUrl: "https://api.deepseek.com/",
      transport,
    });
    await client.complete({ model: "deepseek-v4-flash", prompt: "hi" });
    expect(transport.mock.calls[0][0].url).toBe("https://api.deepseek.com/chat/completions");
  });

  it("strips MULTIPLE trailing slashes (linear, ReDoS-safe) without eating inner slashes", async () => {
    const transport = vi.fn(okChatTransport("x"));
    const client = new OpenAICompatCompletionClient({
      apiKey: "key-12345678",
      baseUrl: "https://api.groq.com/openai/v1///",
      transport,
    });
    await client.complete({ model: "llama-3.3-70b-versatile", prompt: "hi" });
    expect(transport.mock.calls[0][0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("parses choices[0].message.content (empty string when absent)", async () => {
    const transport: CompletionTransport = async () => ({ status: 200, json: { choices: [] } });
    const client = new OpenAICompatCompletionClient({
      apiKey: "key-12345678",
      baseUrl: "https://api.deepseek.com",
      transport,
    });
    expect(await client.complete({ model: "deepseek-v4-flash", prompt: "hi" })).toBe("");
  });

  it("refuses a missing/short key before any network call", async () => {
    const transport = vi.fn(okChatTransport("x"));
    const client = new OpenAICompatCompletionClient({
      apiKey: "short",
      baseUrl: "https://api.deepseek.com",
      transport,
    });
    await expect(client.complete({ model: "deepseek-v4-flash", prompt: "hi" })).rejects.toThrow(
      /apiKey/,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses an empty model id before any network call", async () => {
    const transport = vi.fn(okChatTransport("x"));
    const client = new OpenAICompatCompletionClient({
      apiKey: "key-12345678",
      baseUrl: "https://api.deepseek.com",
      transport,
    });
    await expect(client.complete({ model: "", prompt: "hi" })).rejects.toThrow(/requires a model/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("maps a non-2xx response to a ProposeAdapterError attributed to the provider", async () => {
    const transport: CompletionTransport = async () => ({ status: 429, json: {} });
    const client = new OpenAICompatCompletionClient({
      apiKey: "key-12345678",
      baseUrl: "https://api.groq.com/openai/v1",
      name: "groq",
      transport,
    });
    await expect(
      client.complete({ model: "llama-3.3-70b-versatile", prompt: "hi" }),
    ).rejects.toThrow(/groq API returned HTTP 429/);
  });

  it("does NOT apply the no-opus guard on the OpenAI-compat path", async () => {
    // "opus" is meaningless for a vendor model id here — it must NOT be rejected.
    const transport = vi.fn(okChatTransport("ok"));
    const client = new OpenAICompatCompletionClient({
      apiKey: "key-12345678",
      baseUrl: "https://api.deepseek.com",
      transport,
    });
    await expect(
      client.complete({ model: "some-vendor/opus-flavored-model", prompt: "hi" }),
    ).resolves.toBe("ok");
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe("createRefinerModel — provider-format-aware model id", () => {
  const anthropicClient = mockClient(PROPOSAL_JSON);
  const openaiClient = mockClient(PROPOSAL_JSON);

  it("anthropic format: resolves the tier to a concrete Anthropic id (+ no-opus guard)", () => {
    const model = createRefinerModel(anthropicClient, { format: "anthropic", tier: "haiku" });
    expect(model.id).toBe("claude-haiku-4-5-20251001");
  });

  it("openai format: uses the raw vendor model id verbatim (no tier discipline)", async () => {
    const model = createRefinerModel(openaiClient, {
      format: "openai",
      model: "meta/llama-3.3-70b-instruct",
    });
    expect(model.id).toBe("meta/llama-3.3-70b-instruct");
    await model.complete("hi");
    expect(openaiClient.calls.at(-1)?.model).toBe("meta/llama-3.3-70b-instruct");
  });

  it("defaults to the anthropic path (sonnet) when no format is given (back-compat)", () => {
    const model = createRefinerModel(mockClient(PROPOSAL_JSON));
    expect(model.id).toBe("claude-sonnet-4-6");
  });
});

describe("createCompletionClient — picks the client from the resolved provider format", () => {
  function okChat(text: string): CompletionTransport {
    return async () => ({ status: 200, json: { choices: [{ message: { content: text } }] } });
  }
  function okMessages(text: string): CompletionTransport {
    return async () => ({ status: 200, json: { content: [{ type: "text", text }] } });
  }

  it("openai-format provider → OpenAI Chat-Completions client", async () => {
    const transport = vi.fn(okChat("via-openai"));
    const resolved: ResolvedProvider = {
      name: "nvidia",
      format: "openai",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "nvidia-key-1234",
      defaultModel: "meta/llama-3.3-70b-instruct",
    };
    const client = createCompletionClient(resolved, transport);
    const out = await client.complete({ model: "meta/llama-3.3-70b-instruct", prompt: "hi" });
    expect(out).toBe("via-openai");
    expect(transport.mock.calls[0][0].url).toContain("/chat/completions");
  });

  it("anthropic-format provider → Anthropic Messages client", async () => {
    const transport = vi.fn(okMessages("via-anthropic"));
    const resolved: ResolvedProvider = {
      name: "anthropic",
      format: "anthropic",
      baseUrl: "https://api.anthropic.com/v1/messages",
      apiKey: "anthropic-key-1234",
      defaultModel: "claude-sonnet-4-6",
    };
    const client = createCompletionClient(resolved, transport);
    const out = await client.complete({ model: "claude-sonnet-4-6", prompt: "hi" });
    expect(out).toBe("via-anthropic");
    expect(transport.mock.calls[0][0].url).toContain("/v1/messages");
  });
});
