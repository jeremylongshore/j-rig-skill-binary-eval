import { describe, it, expect } from "vitest";
import { ProviderError, isProviderError } from "./errors.js";
import { CleanProvider } from "./test-fixtures/clean-provider.js";
import { LeakyProvider } from "./test-fixtures/leaky-provider.js";

describe("ProviderError", () => {
  it("carries category, providerName, message", () => {
    const e = new ProviderError({
      category: "rate_limit",
      providerName: "test-provider",
      message: "throttled",
    });
    expect(e.category).toBe("rate_limit");
    expect(e.providerName).toBe("test-provider");
    expect(e.message).toBe("throttled");
    expect(e.name).toBe("ProviderError");
  });

  it("defaults retryable=true for rate_limit + network_timeout", () => {
    expect(
      new ProviderError({
        category: "rate_limit",
        providerName: "p",
        message: "m",
      }).retryable,
    ).toBe(true);
    expect(
      new ProviderError({
        category: "network_timeout",
        providerName: "p",
        message: "m",
      }).retryable,
    ).toBe(true);
  });

  it("defaults retryable=false for authentication + model_not_found", () => {
    expect(
      new ProviderError({
        category: "authentication",
        providerName: "p",
        message: "m",
      }).retryable,
    ).toBe(false);
    expect(
      new ProviderError({
        category: "model_not_found",
        providerName: "p",
        message: "m",
      }).retryable,
    ).toBe(false);
  });

  it("supports explicit retryable override", () => {
    const e = new ProviderError({
      category: "authentication",
      providerName: "p",
      message: "m",
      retryable: true,
    });
    expect(e.retryable).toBe(true);
  });

  it("isProviderError type guard distinguishes from Error", () => {
    const pe = new ProviderError({
      category: "unknown",
      providerName: "p",
      message: "m",
    });
    const e = new Error("plain");
    expect(isProviderError(pe)).toBe(true);
    expect(isProviderError(e)).toBe(false);
    expect(isProviderError(null)).toBe(false);
    expect(isProviderError(undefined)).toBe(false);
  });

  it("preserves prototype chain (instanceof works after re-import simulation)", () => {
    const pe = new ProviderError({
      category: "schema_violation",
      providerName: "p",
      message: "m",
    });
    expect(pe instanceof ProviderError).toBe(true);
    expect(pe instanceof Error).toBe(true);
  });
});

describe("CleanProvider conformance", () => {
  const p = new CleanProvider({ apiKey: "sk-test-clean-12345678" });

  it("complete returns a CompletionResult with finishReason='stop'", async () => {
    const r = await p.complete({
      model: "synthetic/test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.finishReason).toBe("stop");
    expect(r.model).toBe("synthetic/test");
    expect(typeof r.text).toBe("string");
    expect(r.usage.inputTokens).toBe(0);
  });

  it("completeStream yields text_delta then finish", async () => {
    const chunks: unknown[] = [];
    for await (const c of p.completeStream({
      model: "synthetic/test",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(c);
    }
    expect(chunks.length).toBeGreaterThan(0);
    const last = chunks[chunks.length - 1] as { type: string };
    expect(last.type).toBe("finish");
  });

  it("callTool returns toolName when tools provided", async () => {
    const r = await p.callTool({
      model: "synthetic/test",
      messages: [{ role: "user", content: "use the tool" }],
      tools: [
        { name: "do_thing", description: "does it", inputSchema: { type: "object" } },
      ],
    });
    expect(r.toolName).toBe("do_thing");
    expect(r.finishReason).toBe("tool_use");
  });

  it("callTool returns toolName=null when no tools provided", async () => {
    const r = await p.callTool({
      model: "synthetic/test",
      messages: [{ role: "user", content: "no tools" }],
      tools: [],
    });
    expect(r.toolName).toBeNull();
    expect(r.finishReason).toBe("stop");
  });

  it("batch returns one result per request", async () => {
    const results = await p.batch([
      { model: "synthetic/test", messages: [{ role: "user", content: "a" }] },
      { model: "synthetic/test", messages: [{ role: "user", content: "b" }] },
      { model: "synthetic/test", messages: [{ role: "user", content: "c" }] },
    ]);
    expect(results).toHaveLength(3);
  });

  it("complete throws ProviderError(authentication) when apiKey too short", async () => {
    const bad = new CleanProvider({ apiKey: "x" });
    await expect(
      bad.complete({
        model: "synthetic/test",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      category: "authentication",
    });
  });
});

describe("LeakyProvider conformance (still satisfies Provider interface)", () => {
  const p = new LeakyProvider({
    apiKey: "sk-test-leaky-12345678",
    leakStdout: false,
    leakSpawn: false,
  });

  it("complete returns a CompletionResult", async () => {
    // With leak flags off, behaves like clean for the basic contract check.
    const r = await p.complete({
      model: "synthetic/test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.finishReason).toBe("stop");
  });

  it("name + version are populated", () => {
    expect(p.name).toBe("leaky-test-provider");
    expect(p.version).toBe("0.0.0");
  });
});
