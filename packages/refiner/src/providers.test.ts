import { describe, it, expect } from "vitest";
import {
  resolveProvider,
  NoProviderError,
  PROVIDER_REGISTRY,
  AUTO_PICK_ORDER,
} from "./providers.js";

/** A key long enough to clear the >= 8 length guard. */
const KEY = "sk-test-key-1234";

describe("provider registry — shape mirrors the eval command", () => {
  it("carries the four core backends with the right base/key/model/format", () => {
    expect(PROVIDER_REGISTRY.anthropic).toEqual({
      name: "anthropic",
      baseUrl: "https://api.anthropic.com/v1/messages",
      keyEnv: "ANTHROPIC_API_KEY",
      defaultModel: "claude-sonnet-4-6",
      format: "anthropic",
    });
    expect(PROVIDER_REGISTRY.nvidia).toEqual({
      name: "nvidia",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      keyEnv: "NVIDIA_API_KEY",
      defaultModel: "meta/llama-3.3-70b-instruct",
      format: "openai",
    });
    expect(PROVIDER_REGISTRY.deepseek).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      keyEnv: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-v4-flash",
      format: "openai",
    });
    expect(PROVIDER_REGISTRY.groq).toMatchObject({
      baseUrl: "https://api.groq.com/openai/v1",
      keyEnv: "GROQ_API_KEY",
      defaultModel: "llama-3.3-70b-versatile",
      format: "openai",
    });
    // Parity with eval's `minimax` preset (explicit-select only — reasoning
    // model, deliberately NOT in the auto-pick order).
    expect(PROVIDER_REGISTRY.minimax).toMatchObject({
      baseUrl: "https://api.minimax.io/v1",
      keyEnv: "MINIMAX_API_KEY",
      defaultModel: "MiniMax-M3",
      format: "openai",
    });
  });

  it("auto-picks the most dependable free/cheap first; flaky nvidia LAST", () => {
    // Reliability-adjusted cost: groq (dependable free) → deepseek (cheap) →
    // openai (paid, reliable JSON) → anthropic (paid fallback) → nvidia (free but
    // flaky NIM endpoint — kept auto-pickable so an nvidia-only user resolves, but
    // demoted so a dependable key always wins when present).
    expect(AUTO_PICK_ORDER).toEqual(["groq", "deepseek", "openai", "anthropic", "nvidia"]);
  });
});

describe("resolveProvider — explicit --provider wins when its key is set", () => {
  it("resolves the named provider (openai format)", () => {
    const r = resolveProvider({ provider: "deepseek", env: { DEEPSEEK_API_KEY: KEY } });
    expect(r.name).toBe("deepseek");
    expect(r.format).toBe("openai");
    expect(r.baseUrl).toBe("https://api.deepseek.com");
    expect(r.apiKey).toBe(KEY);
    expect(r.defaultModel).toBe("deepseek-v4-flash");
  });

  it("resolves anthropic explicitly (anthropic format)", () => {
    const r = resolveProvider({ provider: "anthropic", env: { ANTHROPIC_API_KEY: KEY } });
    expect(r.name).toBe("anthropic");
    expect(r.format).toBe("anthropic");
    expect(r.baseUrl).toContain("/v1/messages");
  });

  it("honors the `moonshot` → `kimi` alias", () => {
    const r = resolveProvider({ provider: "moonshot", env: { MOONSHOT_API_KEY: KEY } });
    expect(r.name).toBe("kimi");
  });

  it("fails LOUD (never silent fall-through) when the named key is absent", () => {
    expect(() =>
      // groq requested, but only nvidia is keyed — must NOT silently pick nvidia.
      resolveProvider({ provider: "groq", env: { NVIDIA_API_KEY: KEY } }),
    ).toThrow(/GROQ_API_KEY is not set/);
  });

  it("rejects an unknown provider name", () => {
    expect(() => resolveProvider({ provider: "bogus", env: { NVIDIA_API_KEY: KEY } })).toThrow(
      /unknown provider 'bogus'/,
    );
  });
});

describe("resolveProvider — generic LLM_* triple", () => {
  it("resolves a custom OpenAI-compatible endpoint from LLM_BASE_URL + LLM_API_KEY", () => {
    const r = resolveProvider({
      env: {
        LLM_BASE_URL: "https://gateway.example.com/v1",
        LLM_API_KEY: KEY,
        LLM_MODEL: "custom-model-x",
        LLM_PROVIDER: "my-gateway",
      },
    });
    expect(r.name).toBe("my-gateway");
    expect(r.format).toBe("openai");
    expect(r.baseUrl).toBe("https://gateway.example.com/v1");
    expect(r.defaultModel).toBe("custom-model-x");
  });

  it("defaults the name to `openai-compatible` when LLM_PROVIDER is absent", () => {
    const r = resolveProvider({
      env: { LLM_BASE_URL: "https://g.example/v1", LLM_API_KEY: KEY },
    });
    expect(r.name).toBe("openai-compatible");
    expect(r.defaultModel).toBe("");
  });
});

describe("resolveProvider — auto-pick (no --provider, no LLM_* triple)", () => {
  it("prefers a dependable cheap provider over flaky nvidia when both are present", () => {
    // nvidia is $0 but its NIM endpoint is flaky, so a dependable key wins: with
    // nvidia + deepseek + anthropic all set, deepseek (earlier in the order) is
    // chosen — nvidia is the last-resort fallback, not the first pick.
    const r = resolveProvider({
      env: { NVIDIA_API_KEY: KEY, DEEPSEEK_API_KEY: KEY, ANTHROPIC_API_KEY: KEY },
    });
    expect(r.name).toBe("deepseek");
  });

  it("still auto-resolves nvidia when it is the ONLY free/cheap key", () => {
    // Demoting nvidia must not orphan an nvidia-only user: with only NVIDIA_API_KEY
    // set it resolves to nvidia (and gets its runtime behavior) rather than throwing.
    const r = resolveProvider({ env: { NVIDIA_API_KEY: KEY } });
    expect(r.name).toBe("nvidia");
    expect(r.format).toBe("openai");
  });

  it("falls to deepseek when nvidia is absent", () => {
    const r = resolveProvider({ env: { DEEPSEEK_API_KEY: KEY, ANTHROPIC_API_KEY: KEY } });
    expect(r.name).toBe("deepseek");
  });

  it("falls to groq when only groq + anthropic are present", () => {
    const r = resolveProvider({ env: { GROQ_API_KEY: KEY, ANTHROPIC_API_KEY: KEY } });
    expect(r.name).toBe("groq");
  });

  it("falls to anthropic ONLY when it is the sole key (paid fallback)", () => {
    const r = resolveProvider({ env: { ANTHROPIC_API_KEY: KEY } });
    expect(r.name).toBe("anthropic");
    expect(r.format).toBe("anthropic");
  });

  it("just works with ONLY a free/cheap key — Anthropic is never required", () => {
    // The whole point: DeepSeek-only env resolves to a cheap OpenAI-compat model
    // with no ANTHROPIC_API_KEY anywhere.
    const r = resolveProvider({ env: { DEEPSEEK_API_KEY: KEY } });
    expect(r.format).toBe("openai");
    expect(r.name).toBe("deepseek");
  });
});

describe("resolveProvider — no credential", () => {
  it("throws NoProviderError listing every env var it looked for", () => {
    try {
      resolveProvider({ env: {} });
      throw new Error("expected resolveProvider to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(NoProviderError);
      const msg = String((e as Error).message);
      expect(msg).toMatch(/does NOT require Anthropic/);
      // Names each key it checked so the operator knows what to set.
      expect(msg).toMatch(/NVIDIA_API_KEY/);
      expect(msg).toMatch(/DEEPSEEK_API_KEY/);
      expect(msg).toMatch(/GROQ_API_KEY/);
      expect(msg).toMatch(/ANTHROPIC_API_KEY/);
      expect(msg).toMatch(/LLM_API_KEY/);
    }
  });

  it("treats a too-short key as absent", () => {
    expect(() => resolveProvider({ env: { NVIDIA_API_KEY: "short" } })).toThrow(NoProviderError);
  });
});
