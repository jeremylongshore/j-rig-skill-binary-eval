import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCostSession } from "@intentsolutions/refiner";
import type { CostPolicy } from "@intentsolutions/refiner-core";
import { selectJudgeOverride } from "./eval-runtime-context.js";
import { resolveAnthropicModel } from "../providers/anthropic-real.js";

const roots: string[] = [];
beforeEach(() => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "MOONSHOT_API_KEY",
    "KIMI_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "NVIDIA_API_KEY",
    "MINIMAX_API_KEY",
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_MODEL",
  ])
    vi.stubEnv(name, undefined);
  vi.stubEnv("J_RIG_ALLOW_STUB", "1");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected external request");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session() {
  const root = mkdtempSync(join(tmpdir(), "eval-judge-policy-"));
  roots.push(root);
  const policy: CostPolicy = {
    schema: "refiner-cost-policy/v1",
    scopeId: "judge-fixture",
    profile: "custom",
    source: "synthetic local rate",
    files: ["skill"],
    rates: [
      {
        provider: "fixture",
        model: "fixture",
        reportedModels: ["fixture"],
        format: "openai",
        maxInputTokens: 10,
        maxOutputTokens: 10,
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
    maxFileMicros: 100,
    maxTotalMicros: 100,
    meanFileBudgetMicros: 100,
    stopBasisPoints: 10000,
  };
  const policyPath = join(root, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  return openCostSession({
    policyPath,
    ledgerPath: join(root, "ledger.jsonl"),
    fileId: "skill",
    attemptId: "judge-attempt",
  });
}

it("leaves provider selection untouched when both judge flags are absent or blank", () => {
  expect(selectJudgeOverride("sonnet")).toBeNull();
  expect(selectJudgeOverride("sonnet", { judgeProvider: " ", judgeModel: " " })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { judgeProvider: " STUB ", judgeModel: " separate ", expected: "separate" },
  { judgeProvider: "stub", judgeModel: undefined, expected: "sonnet" },
  { judgeProvider: undefined, judgeModel: "separate", expected: "separate" },
])("chooses an explicitly permitted stub identity: $expected", async ({ expected, ...extras }) => {
  const selected = selectJudgeOverride("sonnet", extras);
  expect(selected).toMatchObject({ name: "stub", modelId: expected });
  expect(await selected!.judge.judge("criterion", "prompt", "output")).toMatchObject({
    verdict: "yes",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["stub", undefined])(
  "a shared native cost policy forbids stub judge resolution for %s",
  (judgeProvider) => {
    expect(() =>
      selectJudgeOverride("sonnet", {
        judgeProvider,
        judgeModel: "separate",
        costSession: session(),
      }),
    ).toThrow("Governed cost mode requires a real native judge");
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([undefined, "short"])(
  "refuses explicit Anthropic with missing/short credentials %s",
  (key) => {
    vi.stubEnv("ANTHROPIC_API_KEY", key);
    expect(() => selectJudgeOverride("sonnet", { judgeProvider: "anthropic" })).toThrow(
      "--judge-provider anthropic requires ANTHROPIC_API_KEY",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("refuses an unresolved explicit backend rather than silently substituting a judge", () => {
  expect(() => selectJudgeOverride("sonnet", { judgeProvider: "missing-provider" })).toThrow(
    /requested but no API key resolves/,
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each([undefined, "explicit-judge"])(
  "OpenAI-compatible judge sends exactly its selected model override=%s",
  async (judgeModel) => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("LLM_MODEL", "configured-judge");
    const bodies: { model: string }[] = [];
    const wire = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ verdict: "yes", confidence: 1, reasoning: "fixture" }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", wire);
    const selected = selectJudgeOverride("sonnet", { judgeProvider: "openai", judgeModel });
    expect(selected).toMatchObject({ name: "openai", modelId: judgeModel ?? "configured-judge" });
    expect(await selected!.judge.judge("criterion", "prompt", "output")).toMatchObject({
      verdict: "yes",
    });
    expect(wire).toHaveBeenCalledOnce();
    expect(bodies[0]!.model).toBe(selected!.modelId);
  },
);

it("judge-model alone falls back to the available Anthropic backend and preserves wire identity", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key");
  const bodies: { model: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({ verdict: "yes", confidence: 1, reasoning: "fixture" }),
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    }),
  );
  const selected = selectJudgeOverride("sonnet", { judgeModel: "haiku" });
  expect(selected).toMatchObject({ name: "anthropic", modelId: resolveAnthropicModel("haiku") });
  expect(await selected!.judge.judge("criterion", "prompt", "output")).toMatchObject({
    verdict: "yes",
  });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.model).toBe(resolveAnthropicModel("haiku"));
});
