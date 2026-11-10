import { describe, it, expect } from "vitest";
import { EvaluationTokenUsageSchema, EvaluationUsageEvidenceSchema } from "./evaluation-usage.js";

describe("evaluator usage contract", () => {
  it("allows measured zero and consistent cache TTL subsets", () => {
    expect(EvaluationTokenUsageSchema.parse({ inputTokens: 0, outputTokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(
      EvaluationTokenUsageSchema.safeParse({
        inputTokens: 10,
        outputTokens: 1,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 5,
        cacheCreation5mInputTokens: 3,
        cacheCreation1hInputTokens: 2,
      }).success,
    ).toBe(true);
  });
  it.each([
    { inputTokens: -1, outputTokens: 1 },
    { inputTokens: 1.5, outputTokens: 1 },
    { inputTokens: NaN, outputTokens: 1 },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
    { inputTokens: 5, outputTokens: 1, cachedInputTokens: 3, cacheCreationInputTokens: 3 },
    { inputTokens: 5, outputTokens: 1, cacheCreationInputTokens: 3, cacheCreation5mInputTokens: 3 },
    {
      inputTokens: 5,
      outputTokens: 1,
      cacheCreationInputTokens: 3,
      cacheCreation5mInputTokens: 1,
      cacheCreation1hInputTokens: 1,
    },
    { inputTokens: 1, outputTokens: 1, secret: "omit" },
  ])("rejects malformed or inconsistent accounting: %j", (usage) => {
    expect(EvaluationTokenUsageSchema.safeParse(usage).success).toBe(false);
  });
  it("requires contiguous call identity and permits explicit unknown usage", () => {
    const call = {
      sequence: 0,
      phase: "judge",
      provider: "test",
      requestedModel: "m",
      reportedModel: null,
      outcome: "failed",
      usage: null,
    };
    expect(
      EvaluationUsageEvidenceSchema.safeParse({ schema: "evaluation-usage/v1", calls: [call] })
        .success,
    ).toBe(true);
    expect(
      EvaluationUsageEvidenceSchema.safeParse({
        schema: "evaluation-usage/v1",
        calls: [call, call],
      }).success,
    ).toBe(false);
  });
});
