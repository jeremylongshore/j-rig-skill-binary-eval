import { describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult, ExecutionProvider, Provider } from "@j-rig/core";
import {
  BudgetExceededError,
  BudgetGuardedExecutionProvider,
  BudgetGuardedProvider,
  mergeBudgetLimits,
  RunBudget,
} from "./budget.js";
import { CostTrackingProvider, EvalCostMeter } from "./cost-tracking.js";

function fakeProvider(model: string, input = 100, output = 10): Provider & { calls: number } {
  const p = {
    calls: 0,
    name: "fake",
    version: "0",
    async complete(): Promise<CompletionResult> {
      p.calls++;
      return {
        text: "ok",
        model,
        finishReason: "stop",
        usage: { inputTokens: input, outputTokens: output },
      } as CompletionResult;
    },
    async *completeStream() {
      yield { type: "finish" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async callTool() {
      throw new Error("unused");
    },
    async batch() {
      return [];
    },
  };
  return p as unknown as Provider & { calls: number };
}

const req = (model = "deepseek-v4-flash"): CompletionRequest =>
  ({ model, messages: [{ role: "user", content: "hi" }] }) as CompletionRequest;

/** A budget whose clock the test drives. */
function harness(limits: ConstructorParameters<typeof RunBudget>[0], model = "deepseek-v4-flash") {
  let t = 1_000;
  const budget = new RunBudget(limits, {}, () => t);
  const meter = new EvalCostMeter();
  budget.attach(meter, model);
  const inner = fakeProvider(model);
  const provider = new BudgetGuardedProvider(new CostTrackingProvider(inner, meter), budget);
  return { budget, meter, inner, provider, tick: (ms: number) => (t += ms) };
}

describe("mergeBudgetLimits", () => {
  it("keeps the stricter limit per field and records where it came from", () => {
    expect(
      mergeBudgetLimits(
        { max_usd: 1, max_calls: 50 },
        { max_usd: 2, max_calls: 10, max_tokens: 9 },
      ),
    ).toEqual({
      limits: { max_usd: 1, max_tokens: 9, max_calls: 10 },
      sources: { max_usd: "spec", max_tokens: "run", max_calls: "run" },
    });
    expect(mergeBudgetLimits(undefined, undefined)).toEqual({ limits: {}, sources: {} });
  });
});

describe("RunBudget", () => {
  it("is inert with no limits", async () => {
    const { budget, provider, inner } = harness({});
    for (let i = 0; i < 5; i++) await provider.complete(req());
    expect(budget.active).toBe(false);
    expect(budget.check()).toBeNull();
    expect(inner.calls).toBe(5);
  });

  it("refuses the call after max_calls and latches why", async () => {
    const { budget, provider, inner } = harness({ max_calls: 2 });
    await provider.complete(req());
    await provider.complete(req());
    await expect(provider.complete(req())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(inner.calls).toBe(2);
    expect(budget.stop).toMatchObject({
      limit: "max_calls",
      max: 2,
      observed: 2,
      phase: "trigger",
      model: "deepseek-v4-flash",
      reason: "made 2 calls of max_calls 2",
    });
    // Latched: the first stop is never overwritten.
    await expect(provider.complete(req())).rejects.toThrow("eval budget exhausted: made 2 calls");
    expect(inner.calls).toBe(2);
  });

  it("stops on max_tokens counting input and output", async () => {
    const { budget, provider } = harness({ max_tokens: 200 });
    await provider.complete(req()); // 110
    await provider.complete(req()); // 220 — reaches the limit after the call
    await expect(provider.complete(req())).rejects.toThrow(BudgetExceededError);
    expect(budget.stop).toMatchObject({ limit: "max_tokens", observed: 220 });
  });

  it("stops on max_usd from the rate table", async () => {
    // deepseek-v4-flash: 100 in @ 0.14 + 10 out @ 0.28 per MTok = $0.0000168 per call
    const { budget, provider, inner } = harness({ max_usd: 0.00003 });
    await provider.complete(req());
    await provider.complete(req());
    await expect(provider.complete(req())).rejects.toThrow(BudgetExceededError);
    expect(inner.calls).toBe(2);
    expect(budget.stop?.limit).toBe("max_usd");
    expect(budget.stop?.observed).toBeCloseTo(0.0000336, 10);
  });

  it("fails closed on max_usd when a model has no rate on file", async () => {
    const { budget, provider, inner } = harness({ max_usd: 100 }, "mystery-model");
    await provider.complete(req("mystery-model"));
    await expect(provider.complete(req("mystery-model"))).rejects.toThrow(/no rate on file/);
    expect(inner.calls).toBe(1);
    expect(budget.stop).toMatchObject({ limit: "max_usd", observed: null });
  });

  it("stops on max_wall_ms from the injected clock", async () => {
    const { budget, provider, tick } = harness({ max_wall_ms: 500 });
    await provider.complete(req());
    tick(499);
    await provider.complete(req());
    tick(1);
    await expect(provider.complete(req())).rejects.toThrow(BudgetExceededError);
    expect(budget.stop).toMatchObject({ limit: "max_wall_ms", observed: 500 });
  });

  it("spans models: spend from an earlier model counts toward the limit", async () => {
    const budget = new RunBudget({ max_calls: 3 });
    const m1 = new EvalCostMeter();
    budget.attach(m1, "deepseek-v4-flash");
    const p1 = new BudgetGuardedProvider(
      new CostTrackingProvider(fakeProvider("deepseek-v4-flash"), m1),
      budget,
    );
    await p1.complete(req());
    await p1.complete(req());
    const m2 = new EvalCostMeter();
    m2.phase = "judge";
    budget.attach(m2, "second");
    const p2 = new BudgetGuardedProvider(
      new CostTrackingProvider(fakeProvider("second"), m2),
      budget,
    );
    await p2.complete(req("second"));
    await expect(p2.complete(req("second"))).rejects.toThrow(BudgetExceededError);
    expect(budget.stop).toMatchObject({
      limit: "max_calls",
      observed: 3,
      model: "second",
      phase: "judge",
    });
    expect(budget.summary().spent.calls).toBe(3);
  });

  it("guards an execution provider before it runs a case", async () => {
    const budget = new RunBudget({ max_calls: 1 });
    const meter = new EvalCostMeter();
    budget.attach(meter, "claude-code/claude-sonnet-5-5");
    meter.record("claude-code/claude-sonnet-5-5", { inputTokens: 10, outputTokens: 1 });
    const execute = vi.fn();
    const guarded = new BudgetGuardedExecutionProvider(
      { execute } as unknown as ExecutionProvider,
      budget,
    );
    await expect(guarded.execute("p", { skill_body: "" })).rejects.toThrow(BudgetExceededError);
    expect(execute).not.toHaveBeenCalled();
  });
});
