import { afterEach, describe, expect, it, vi } from "vitest";
import { selectJudgeOverride } from "./eval.js";
import { resolveAnthropicModel } from "../providers/anthropic-real.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Anthropic judge identity", () => {
  it.each(["sonnet", "anthropic/haiku", "claude-sonnet-4-6"])(
    "reports the actual transport model for %s",
    async (model) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ verdict: "yes", confidence: 1, reasoning: "satisfied" }),
                },
              ],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200 },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const selected = selectJudgeOverride("haiku", {
        judgeProvider: "anthropic",
        judgeModel: model,
      });
      if (!selected) throw new Error("missing judge");
      await selected.judge.judge("criterion", "prompt", "output");
      const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
      const request = JSON.parse(calls[0][1].body as string) as { model: string };
      expect(selected.modelId).toBe(resolveAnthropicModel(model));
      expect(selected.modelId).toBe(request.model);
    },
  );
});
