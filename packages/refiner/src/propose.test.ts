import { describe, it, expect, vi } from "vitest";
import {
  makeSkillDoc,
  NaiveInContextStrategy,
  SkillOptStyleStrategy,
} from "@intentsolutions/refiner-core";
import {
  propose,
  createRefinerModel,
  resolveProposeModelId,
  assertNotOpus,
  AnthropicCompletionClient,
  ProposeAdapterError,
  type CompletionClient,
  type CompletionTransport,
} from "./propose.js";

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
