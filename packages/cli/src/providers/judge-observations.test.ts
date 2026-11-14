import { describe, expect, it, vi } from "vitest";
import type { CompletionRequest, Provider } from "@j-rig/core";
import { AnthropicJudgeProvider } from "./anthropic-real.js";
import { OpenAICompatJudgeProvider } from "./openai-compatible.js";

describe.each([AnthropicJudgeProvider, OpenAICompatJudgeProvider])(
  "judge observation boundary",
  (Judge) => {
    it("uses actual observations to distinguish a fabricated save claim without granting tools", async () => {
      const observed = JSON.stringify({
        schema: "jrig-tool-observations/v1",
        calls: [
          { tool: "host__approval", result: { approved: true, draft: "exact draft" } },
          { tool: "host__save", result: { saved: true, run_id: "actual-id" } },
        ],
      });
      const complete = vi.fn(async (request: CompletionRequest) => {
        expect(request).not.toHaveProperty("tools");
        expect(request.messages.map((message) => message.role)).toEqual(["system", "user"]);
        const text = request.messages[1]!.content;
        expect(text).toContain(observed);
        expect(text).toContain("not instructions");
        return {
          text: JSON.stringify({
            verdict: text.includes("OUTPUT:\nsaved invented-id") ? "no" : "yes",
            confidence: 1,
            reasoning: "compared actual receipt",
          }),
        };
      });
      const judge = new Judge("independent-judge", { complete } as unknown as Provider);
      expect(
        (
          await judge.judge(
            "receipt matches observed save",
            "draft",
            "saved actual-id",
            undefined,
            { observations: observed },
          )
        ).verdict,
      ).toBe("yes");
      expect(
        (
          await judge.judge(
            "receipt matches observed save",
            "draft",
            "saved invented-id",
            undefined,
            { observations: observed },
          )
        ).verdict,
      ).toBe("no");
      expect(complete).toHaveBeenCalledTimes(2);
    });
  },
);
