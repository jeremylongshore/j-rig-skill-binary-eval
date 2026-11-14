import { describe, expect, it } from "vitest";
import {
  CostPolicySchema,
  CostRateSchema,
  costStopMicros,
  priceCostUsage,
  reserveCost,
  safeMicros,
  type CostRate,
} from "./cost-policy.js";
const rate: CostRate = {
  provider: "fixture",
  model: "model",
  reportedModels: ["model"],
  format: "anthropic",
  maxInputTokens: 1000000,
  maxOutputTokens: 1000000,
  protocolOverheadTokens: 0,
  microsPerMillionTokens: {
    input: 1000000,
    output: 2000000,
    cacheRead: 100000,
    cacheWrite: 1500000,
    cacheWrite5m: 1250000,
    cacheWrite1h: 2000000,
  },
};
describe("explicit reproducible prices", () => {
  it("prices cache TTLs without double counting inclusive input", () => {
    expect(
      priceCostUsage(rate, {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 40,
        cacheCreation5mInputTokens: 20,
        cacheCreation1hInputTokens: 20,
      }),
    ).toBe(127);
    expect(
      priceCostUsage(rate, {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 40,
      }),
    ).toBe(122);
  });
  it("rounds up once per call and reserves the most expensive cache category", () => {
    expect(priceCostUsage(rate, { inputTokens: 1, outputTokens: 0, cachedInputTokens: 1 })).toBe(1);
    expect(reserveCost(rate, 100)).toBe(2000200);
  });
  it("rejects malformed usage, bounds, rates and unsafe arithmetic", () => {
    expect(() =>
      priceCostUsage(rate, { inputTokens: 1, outputTokens: 0, cachedInputTokens: 2 }),
    ).toThrow();
    expect(() => reserveCost(rate, 1000001)).toThrow();
    expect(() => reserveCost(rate, NaN)).toThrow();
    expect(() => safeMicros(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow();
    expect(() => safeMicros(-1n)).toThrow();
    expect(() => CostRateSchema.parse({ ...rate, reportedModels: ["model", "model"] })).toThrow();
  });
  it("pins the Wave B policy and its 80 percent stop", () => {
    const policy = {
      schema: "refiner-cost-policy/v1",
      scopeId: "wave",
      profile: "wave-b",
      source: "fixture",
      files: ["a"],
      rates: [rate],
      maxFileMicros: 200000000,
      maxTotalMicros: 35000000000,
      meanFileBudgetMicros: 50000000,
      stopBasisPoints: 8000,
    };
    expect(costStopMicros(CostPolicySchema.parse(policy))).toBe(28000000000);
    expect(() => CostPolicySchema.parse({ ...policy, stopBasisPoints: 9000 })).toThrow();
    expect(() => CostPolicySchema.parse({ ...policy, files: ["a", "a"] })).toThrow();
    expect(() => CostPolicySchema.parse({ ...policy, rates: [rate, rate] })).toThrow();
    expect(() =>
      CostPolicySchema.parse({
        ...policy,
        profile: "custom",
        maxTotalMicros: 1,
        stopBasisPoints: 1,
      }),
    ).toThrow();
  });
});
