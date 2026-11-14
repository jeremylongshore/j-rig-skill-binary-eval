import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveExecutionParameters,
  resolveRunBudgetLimits,
  resolveSpecOptions,
} from "./eval-preflight.js";

const opts = { models: " flag-a, flag-b " };
const spec = { models: ["spec-a", "spec-b"], samples: 3 };
const env = { DEEPSEEK_API_KEY: "fixture-not-a-real-key" };
// Exercise current CLI wiring even when a caller has stale bundled output.
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

describe("eval preflight", () => {
  it.each([false, true])("preserves explicit model precedence (%s)", (explicit) => {
    const resolved = resolveSpecOptions(opts, spec, explicit);
    expect(resolved.models).toEqual(explicit ? ["flag-a", "flag-b"] : spec.models);
    expect(resolved.judgeSamples).toBe(3);
  });
  it("retains CLI fallback, empty CSV entries and absent samples", () => {
    expect(resolveSpecOptions({ models: "a, ,b" }, { models: [] }, false)).toEqual({
      models: ["a", "", "b"],
      judgeSamples: undefined,
      budgetLimits: { limits: {}, sources: {} },
    });
  });
  it("preserves Number conversion and CLI sample override", () => {
    expect(resolveSpecOptions({ ...opts, samples: "2e1" }, spec, false).judgeSamples).toBe(20);
  });
  it.each(["0", "-1", "2.5", "", "NaN", "Infinity"])(
    "refuses sample %j before budget errors",
    (samples) => {
      expect(() => resolveSpecOptions({ ...opts, samples, maxUsd: "bad" }, spec, false)).toThrow(
        `--samples must be a positive integer, got "${samples}"`,
      );
    },
  );
  it("refuses unreviewed specs before samples and budgets", () => {
    expect(() =>
      resolveSpecOptions(
        { ...opts, requireReviewed: true, samples: "bad", maxUsd: "bad" },
        { ...spec, tags: ["needs-review"] },
        false,
      ),
    ).toThrow("eval spec is tagged needs-review");
  });
  it("retains stricter budgets and their provenance without mutating inputs", () => {
    const budget = Object.freeze({ max_usd: 2, max_tokens: 200 });
    const result = resolveSpecOptions(
      { ...opts, maxUsd: "3", maxTokens: "100", maxCalls: "4" },
      { ...spec, budget },
      false,
    );
    expect(result.budgetLimits).toEqual({
      limits: { max_usd: 2, max_tokens: 100, max_calls: 4 },
      sources: { max_usd: "spec", max_tokens: "run", max_calls: "run" },
    });
  });
  it("preserves budget validation order and decimal USD", () => {
    expect(resolveRunBudgetLimits({ maxUsd: "0.25" })).toEqual({ max_usd: 0.25 });
    expect(() => resolveRunBudgetLimits({ maxUsd: "bad", maxTokens: "bad" })).toThrow(
      '--max-usd must be a positive number, got "bad"',
    );
    expect(() => resolveRunBudgetLimits({ maxTokens: "2.5" })).toThrow(
      '--max-tokens must be a positive integer, got "2.5"',
    );
  });
  it("leaves unspecified reasoning absent", () => {
    expect(resolveExecutionParameters({}, {})).toBeUndefined();
  });
  it.each(["none", "low", "medium", "high", "max"])(
    "accepts real compatible reasoning %s",
    (executionReasoningEffort) => {
      expect(
        resolveExecutionParameters({ executionReasoningEffort, provider: " DeepSeek " }, env),
      ).toEqual({ reasoning_effort: executionReasoningEffort });
    },
  );
  it.each([
    { provider: "stub" },
    { provider: "anthropic" },
    { functional: false },
    { provider: "missing" },
  ])("refuses incompatible reasoning %j", (options) => {
    expect(() =>
      resolveExecutionParameters({ ...options, executionReasoningEffort: "high" }, env),
    ).toThrow("--execution-reasoning-effort requires real OpenAI-compatible functional execution");
  });
  it("validates reasoning spelling before provider compatibility", () => {
    expect(() =>
      resolveExecutionParameters({ executionReasoningEffort: "HIGH", provider: "stub" }, {}),
    ).toThrow("--execution-reasoning-effort must be none, low, medium, high, or max");
  });
  it.each([
    {
      flags: ["--samples", "2.5", "--max-usd", "bad"],
      error: '--samples must be a positive integer, got "2.5"',
    },
    { flags: ["--max-usd", "bad"], error: '--max-usd must be a positive number, got "bad"' },
  ])("refuses $error before opening the database", ({ flags, error }) => {
    const root = mkdtempSync(join(tmpdir(), "jrig-spec-preflight-"));
    try {
      const db = join(root, "must-not-exist.db");
      const cli = fileURLToPath(new URL("../index.ts", import.meta.url));
      const skill = fileURLToPath(new URL("../../../../skill", import.meta.url));
      const result = spawnSync(
        process.execPath,
        [
          // Match the version constant normally injected by tsup.
          "--import",
          'data:text/javascript,globalThis.__CLI_VERSION__="preflight-test"',
          "--import",
          tsxLoader,
          cli,
          "eval",
          skill,
          "--spec",
          join(skill, "eval.yaml"),
          "--provider",
          "stub",
          "--db",
          db,
          ...flags,
        ],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH, J_RIG_ALLOW_STUB: "1" },
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr.trim()).toBe(`Error: ${error}`);
      expect(existsSync(db)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("refuses execution options before loading missing skills, MCP or opening DB", () => {
    const root = mkdtempSync(join(tmpdir(), "jrig-preflight-"));
    try {
      const db = join(root, "must-not-exist.db");
      const cli = fileURLToPath(new URL("../index.ts", import.meta.url));
      const result = spawnSync(
        process.execPath,
        [
          // Match the version constant normally injected by tsup.
          "--import",
          'data:text/javascript,globalThis.__CLI_VERSION__="preflight-test"',
          "--import",
          tsxLoader,
          cli,
          "eval",
          join(root, "missing-skill"),
          "--provider",
          "stub",
          "--execution-reasoning-effort",
          "invalid",
          "--execution-provider",
          "invalid",
          "--mcp-config",
          join(root, "missing-mcp"),
          "--db",
          db,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr.trim()).toBe(
        "Error: --execution-reasoning-effort must be none, low, medium, high, or max",
      );
      expect(existsSync(db)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
