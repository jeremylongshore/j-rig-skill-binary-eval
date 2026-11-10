import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CostLedger, createCostTransport } from "@intentsolutions/refiner";
import { type CostPolicy } from "@intentsolutions/refiner-core";
import { createMiniMaxPlanTransport } from "./minimax-plan.js";
import type { Transport } from "./transport.js";
it.each(["priced-retry", "cap-refusal", "unknown-refusal"])(
  "MiniMax wire reservation: %s",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "native-cost-retry-"));
    try {
      const policy: CostPolicy = {
        schema: "refiner-cost-policy/v1",
        profile: "custom",
        scopeId: "fixture",
        source: "synthetic",
        files: ["skill"],
        rates: [
          {
            provider: "minimax",
            model: "MiniMax-M3",
            reportedModels: ["MiniMax-M3"],
            format: "openai",
            maxInputTokens: 1000,
            maxOutputTokens: 100,
            protocolOverheadTokens: 0,
            microsPerMillionTokens: {
              input: 1000000,
              output: 1000000,
              cacheRead: 1000000,
              cacheWrite: 1000000,
              cacheWrite5m: 1000000,
              cacheWrite1h: 1000000,
            },
          },
        ],
        maxFileMicros: mode === "cap-refusal" ? 1105 : 3000,
        maxTotalMicros: 5000,
        meanFileBudgetMicros: 3000,
        stopBasisPoints: 8000,
      };
      const ledger = new CostLedger(join(root, "ledger.jsonl"), policy);
      let wireCalls = 0;
      const inner = vi.fn<Transport>(async () =>
        ++wireCalls === 1
          ? {
              status: 429,
              json: {
                model: "MiniMax-M3",
                error: { message: "Token Plan rate limit reached (2062)" },
                ...(mode === "unknown-refusal"
                  ? {}
                  : { usage: { prompt_tokens: 10, completion_tokens: 1 } }),
              },
            }
          : {
              status: 200,
              json: {
                model: "MiniMax-M3",
                usage: { prompt_tokens: 2, completion_tokens: 1 },
                choices: [],
              },
            },
      );
      const refused = vi.fn();
      let time = 1800000000000;
      const transport = createMiniMaxPlanTransport(
        createCostTransport(inner, ledger, {
          provider: "minimax",
          format: "openai",
          fileId: "skill",
          attemptId: "attempt",
          phase: "judge",
          onAdmissionRefused: refused,
        }),
        {
          now: () => time,
          sleep: async (ms) => {
            time += ms;
          },
          observe: () => {},
          fetchQuota: async () => ({
            base_resp: { status_code: 0 },
            model_remains: [
              {
                model_name: "general",
                current_interval_remaining_percent: 80,
                current_weekly_remaining_percent: 75,
                end_time: time + 18000000,
                weekly_end_time: time + 604800000,
              },
            ],
          }),
        },
      );
      const action = transport({
        url: "https://api.minimax.io/v1/chat/completions",
        method: "POST",
        headers: { authorization: "Bearer fixture-only" },
        body: {
          model: "MiniMax-M3",
          max_tokens: 100,
          messages: [{ role: "user", content: "fixture" }],
        },
      });
      if (mode === "priced-retry") {
        await expect(action).resolves.toMatchObject({ status: 200 });
        expect(inner).toHaveBeenCalledTimes(2);
        expect(ledger.snapshot().total.knownMicros).toBe(14);
        expect(refused).not.toHaveBeenCalled();
      } else {
        await expect(action).rejects.toThrow();
        expect(inner).toHaveBeenCalledTimes(1);
        expect(refused).toHaveBeenCalledTimes(1);
        expect(ledger.snapshot().total).toMatchObject({
          knownMicros: mode === "cap-refusal" ? 11 : 0,
          committedMicros: mode === "cap-refusal" ? 11 : 1100,
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
