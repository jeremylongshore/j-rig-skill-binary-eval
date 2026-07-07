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
import { CostTrackingProvider, EvalCostMeter } from "./cost-tracking.js";

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

  it("delegates results unchanged (transparent decorator)", async () => {
    const meter = new EvalCostMeter();
    const p = new CostTrackingProvider(fakeProvider("m"), meter);
    const res = await p.complete(req());
    expect(res.text).toBe("ok");
    expect(p.name).toBe("fake");
    expect(p.version).toBe("0.0.0");
  });
});
