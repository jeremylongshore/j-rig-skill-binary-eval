import { describe, it, expect } from "vitest";
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  ProviderError,
  StreamChunk,
  ToolCallResult,
  ToolDefinition,
} from "@j-rig/core";
import {
  CostTrackingProvider,
  EvalCostMeter,
  lookupModelRate,
  MODEL_RATES_USD_PER_MTOK,
  priceUsage,
} from "./cost-tracking.js";

function completion(model: string, input: number, output: number): CompletionResult {
  return {
    text: "ok",
    model,
    usage: { inputTokens: input, outputTokens: output },
    finishReason: "stop",
  };
}

function fakeProvider(model: string): Provider {
  return {
    name: "fake",
    version: "0.0.0",
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      return completion(model ?? req.model, 100, 10);
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async *completeStream(_req: CompletionRequest): AsyncIterable<StreamChunk> {
      yield { type: "text_delta", delta: "ok" };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 7, outputTokens: 3 },
      };
    },
    async callTool(req: CompletionRequest & { tools: ToolDefinition[] }): Promise<ToolCallResult> {
      return {
        toolName: null,
        toolArguments: null,
        toolCallId: null,
        text: "ok",
        usage: { inputTokens: 5, outputTokens: 2 },
        finishReason: "stop",
        model: req.model,
      } as ToolCallResult;
    },
    async batch(reqs: CompletionRequest[]): Promise<Array<CompletionResult | ProviderError>> {
      return reqs.map((r) => completion(r.model, 1, 1));
    },
  };
}

const req = (model = "test-model"): CompletionRequest => ({
  model,
  messages: [{ role: "user", content: "hi" }],
});

describe("EvalCostMeter", () => {
  it("attributes usage to the current phase", async () => {
    const meter = new EvalCostMeter();
    const p = new CostTrackingProvider(fakeProvider("m"), meter);

    meter.phase = "trigger";
    await p.complete(req());
    meter.phase = "execution";
    await p.complete(req());
    await p.complete(req());
    meter.phase = "judge";
    await p.complete(req());

    const r = meter.report();
    expect(r.phases.trigger.calls).toBe(1);
    expect(r.phases.execution.calls).toBe(2);
    expect(r.phases.judge.calls).toBe(1);
    expect(r.total.calls).toBe(4);
    expect(r.total.input_tokens).toBe(400);
    expect(r.total.output_tokens).toBe(40);
  });

  it("estimates USD from the rate table for a known model", async () => {
    const meter = new EvalCostMeter();
    const p = new CostTrackingProvider(fakeProvider("deepseek-v4-flash"), meter);
    await p.complete(req("deepseek-v4-flash"));

    const r = meter.report();
    // 100 in @ $0.14/MTok + 10 out @ $0.28/MTok
    expect(r.estimated_usd).toBeCloseTo((100 * 0.14 + 10 * 0.28) / 1_000_000, 12);
    expect(r.by_model).toHaveLength(1);
    expect(r.by_model[0]!.model).toBe("deepseek-v4-flash");
  });

  it("reports free-tier judges as $0, not unknown", async () => {
    const meter = new EvalCostMeter();
    const p = new CostTrackingProvider(fakeProvider("llama-3.3-70b-versatile"), meter);
    await p.complete(req("llama-3.3-70b-versatile"));

    const r = meter.report();
    expect(r.estimated_usd).toBe(0);
    expect(r.by_model[0]!.usd).toBe(0);
  });

  it("fails honest on an unknown model: null estimate, never a partial figure", async () => {
    const meter = new EvalCostMeter();
    const known = new CostTrackingProvider(fakeProvider("deepseek-v4-flash"), meter);
    const unknown = new CostTrackingProvider(fakeProvider("mystery-model"), meter);
    await known.complete(req("deepseek-v4-flash"));
    await unknown.complete(req("mystery-model"));

    const r = meter.report();
    expect(r.estimated_usd).toBeNull();
    expect(r.by_model.find((m) => m.model === "mystery-model")!.usd).toBeNull();
    expect(r.by_model.find((m) => m.model === "deepseek-v4-flash")!.usd).not.toBeNull();
  });

  it("records streaming usage from the finish chunk", async () => {
    const meter = new EvalCostMeter();
    const p = new CostTrackingProvider(fakeProvider("m"), meter);
    meter.phase = "execution";
    const chunks: StreamChunk[] = [];
    for await (const c of p.completeStream(req("stream-model"))) chunks.push(c);

    expect(chunks.at(-1)!.type).toBe("finish");
    const r = meter.report();
    expect(r.phases.execution.input_tokens).toBe(7);
    expect(r.phases.execution.output_tokens).toBe(3);
  });

  it("records tool-call and batch usage", async () => {
    const meter = new EvalCostMeter();
    const p = new CostTrackingProvider(fakeProvider("m"), meter);
    await p.callTool({ ...req("tool-model"), tools: [] });
    await p.batch([req("batch-model"), req("batch-model")]);

    const r = meter.report();
    expect(r.total.calls).toBe(3);
    expect(r.total.input_tokens).toBe(5 + 1 + 1);
  });

  it("ignores a missing usage object instead of propagating NaN", () => {
    const meter = new EvalCostMeter();
    meter.record("m", undefined as unknown as import("@j-rig/core").TokenUsage);
    meter.record("m", {} as import("@j-rig/core").TokenUsage);

    const r = meter.report();
    expect(r.total.calls).toBe(1); // the {} usage counts as a call with 0 tokens
    expect(r.total.input_tokens).toBe(0);
    expect(Number.isNaN(r.total.input_tokens)).toBe(false);
  });

  it("delegates results unchanged (transparent decorator)", async () => {
    const meter = new EvalCostMeter();
    const p = new CostTrackingProvider(fakeProvider("m"), meter);
    const res = await p.complete(req());
    expect(res.text).toBe("ok");
    expect(p.name).toBe("fake");
    expect(p.version).toBe("0.0.0");
  });
});

describe("model rates (MiniMax + Claude)", () => {
  it("carries the current list prices for the estate's MiniMax and Claude models", () => {
    // MiniMax pay-as-you-go Standard (<= 512k input) and Anthropic first-party
    // list prices; the source and read date sit beside the table.
    expect(MODEL_RATES_USD_PER_MTOK["MiniMax-M3"]).toMatchObject({
      input: 0.3,
      output: 1.2,
      cached_input: 0.06,
    });
    expect(MODEL_RATES_USD_PER_MTOK["MiniMax-M2.7-highspeed"]).toMatchObject({
      input: 0.6,
      output: 2.4,
      cached_input: 0.06,
    });
    expect(MODEL_RATES_USD_PER_MTOK["MiniMax-M2.7"]).toMatchObject({ input: 0.3, output: 1.2 });
    expect(MODEL_RATES_USD_PER_MTOK["claude-fable-5-1"]).toMatchObject({
      input: 10,
      output: 50,
      cached_input: 0.25,
    });
    expect(MODEL_RATES_USD_PER_MTOK["claude-opus-5-5"]).toMatchObject({
      input: 4,
      output: 20,
      cached_input: 0.2,
    });
    expect(MODEL_RATES_USD_PER_MTOK["claude-sonnet-5-5"]).toMatchObject({
      input: 2,
      output: 10,
      cached_input: 0.2,
    });
    expect(MODEL_RATES_USD_PER_MTOK["claude-haiku-4-5-20251001"]).toMatchObject({
      input: 1,
      output: 5,
      cached_input: 0.1,
    });
  });

  it("looks up exact, case-insensitive and subscription-prefixed ids; never guesses", () => {
    expect(lookupModelRate("MiniMax-M3")).toMatchObject({ key: "MiniMax-M3", billed: true });
    expect(lookupModelRate("minimax-m3")).toMatchObject({ key: "MiniMax-M3", billed: true });
    expect(lookupModelRate("claude-code/claude-sonnet-5-5")).toMatchObject({
      key: "claude-sonnet-5-5",
      billed: false,
    });
    expect(lookupModelRate("claude-haiku-4-5")?.rate.input).toBe(1);
    // A model with no verified rate stays unpriced.
    expect(lookupModelRate("claude-haiku-5-5")).toBeNull();
    expect(lookupModelRate("claude-code/claude-haiku-5-5")).toBeNull();
  });

  it("prices cache reads at the cache rate as a subset of input", () => {
    const rate = MODEL_RATES_USD_PER_MTOK["claude-opus-5-5"]!;
    // 1M input of which 800k cache reads, 100k output:
    // 200k * $4 + 800k * $0.20 + 100k * $20 = 0.8 + 0.16 + 2.0
    expect(
      priceUsage(rate, {
        input_tokens: 1_000_000,
        cached_input_tokens: 800_000,
        output_tokens: 100_000,
      }),
    ).toBeCloseTo(2.96, 10);
    // A row without a cache rate prices cache reads at the input rate.
    expect(
      priceUsage(
        { input: 1, output: 0 },
        { input_tokens: 10, cached_input_tokens: 4, output_tokens: 0 },
      ),
    ).toBeCloseTo(10 / 1_000_000, 12);
  });

  it("reports subscription claude-code usage as API-equivalent, not billed", () => {
    const meter = new EvalCostMeter();
    meter.phase = "execution";
    meter.record("claude-code/claude-sonnet-5-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    meter.phase = "judge";
    meter.record("MiniMax-M3", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const r = meter.report();
    const cc = r.by_model.find((m) => m.model.startsWith("claude-code/"))!;
    expect(cc).toMatchObject({
      billed: false,
      rate_key: "claude-sonnet-5-5",
      cached_input_tokens: 1_000_000,
      note: "API-equivalent at list rate; Claude Code subscription run, not billed",
    });
    expect(cc.usd).toBeCloseTo(0.2, 10);
    expect(r.estimated_usd).toBeCloseTo(0.2 + 1.5, 10);
    expect(r.billed_usd).toBeCloseTo(1.5, 10);
  });

  it("nulls billed_usd with estimated_usd when a model is unpriced", () => {
    const meter = new EvalCostMeter();
    meter.record("claude-code/claude-haiku-5-5", { inputTokens: 1, outputTokens: 1 });
    const r = meter.report();
    expect(r.estimated_usd).toBeNull();
    expect(r.billed_usd).toBeNull();
    expect(r.by_model[0]).toMatchObject({ usd: null, rate_key: null, billed: false });
  });
});
