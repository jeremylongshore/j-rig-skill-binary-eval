import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { EvaluationUsageEvidenceSchema } from "@intentsolutions/refiner-core";

const cli = join(import.meta.dirname, "../../dist/index.js");
const skill = join(import.meta.dirname, "../../../../skill");
const fake = join(import.meta.dirname, "../providers/__fixtures__/claude-code/fake-claude.mjs");

// Always launch the repository-owned executable fixture. No live subscription,
// inherited credentials, API keys, or external endpoint is used, including in CI.
function run(prompt: string, flags: string[] = ["--max-tokens", "100000"]) {
  const root = mkdtempSync(join(tmpdir(), "jrig-subscription-e2e-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    chmodSync(fake, 0o755);
    symlinkSync(fake, join(bin, "claude"));
    writeFileSync(
      join(root, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "synthetic-test-token",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );
    const spec = parse(readFileSync(join(skill, "eval.yaml"), "utf8")) as Record<string, unknown>;
    spec.criteria = [
      {
        id: "output",
        description: "nonempty",
        method: "deterministic",
        deterministic_check: "not_empty",
      },
    ];
    spec.test_cases = [
      {
        id: "case",
        description: "fixture",
        tier: "core",
        prompt,
        trigger_expectation: "should_trigger",
        criteria_ids: ["output"],
      },
    ];
    const specFile = join(root, "eval.yaml");
    writeFileSync(specFile, stringify(spec));
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "eval",
        skill,
        "--spec",
        specFile,
        "--provider",
        "stub",
        "--models",
        "claude-haiku-4-5",
        "--no-trigger",
        "--execution-provider",
        "claude-code",
        "--db",
        join(root, "run.db"),
        "--json",
        ...flags,
      ],
      {
        encoding: "utf8",
        timeout: 25000,
        env: {
          PATH: [bin, dirname(process.execPath)].join(delimiter),
          HOME: root,
          CLAUDE_CONFIG_DIR: root,
          J_RIG_ALLOW_STUB: "1",
        },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.stdout, result.stderr).not.toBe("");
    const row = JSON.parse(result.stdout)["claude-haiku-4-5"] as Record<string, unknown>;
    const cost = row.cost as {
      usage_evidence: unknown;
      unknown_calls: number;
      billed_usd: number | null;
    };
    const evidence = EvaluationUsageEvidenceSchema.parse(cost.usage_evidence);
    return { exit: result.status, row, cost, calls: evidence.calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("subscription accounting through the actual eval CLI", { timeout: 30000 }, () => {
  it("distinguishes explicit zero usage from absence and retains subscription billing", () => {
    const r = run('MEASUREMENT {"noInit":true,"usage":{"input_tokens":0,"output_tokens":0}}');
    expect(r.exit).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      provider: "claude-code",
      requestedModel: "claude-haiku-4-5",
      reportedModel: null,
      outcome: "completed",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(r.cost.billed_usd).toBe(0);
  });

  it.each(["--max-tokens", "--max-usd"])(
    "fails closed on missing usage on the final successful call (%s)",
    (flag) => {
      const r = run('MEASUREMENT {"noInit":true}', [flag, "100000"]);
      expect(r.exit).toBe(3);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toMatchObject({ outcome: "completed", usage: null });
      expect(r.row.budget_stop).toMatchObject({
        limit: flag === "--max-tokens" ? "max_tokens" : "max_usd",
        observed: null,
      });
    },
  );

  it.each(["FAIL", "CRASH"])("retains failed attempt and provider error for %s", (prompt) => {
    const r = run(prompt);
    expect(r.exit).toBe(2);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ outcome: "failed", usage: null });
    expect(r.cost.unknown_calls).toBe(1);
    expect(r.row.gate_decision).toBe("error");
    expect(r.row).not.toHaveProperty("budget_stop");
  });

  it("preserves cache-write TTLs and reported model separately from the alias", () => {
    const r = run("FIXTURE write-receipt");
    expect(r.exit).toBe(0);
    expect(r.calls[0]).toMatchObject({
      requestedModel: "claude-haiku-4-5",
      reportedModel: "claude-haiku-5-5",
      usage: {
        inputTokens: 44090,
        outputTokens: 321,
        cachedInputTokens: 32766,
        cacheCreationInputTokens: 11316,
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 11316,
      },
    });
  });

  it("keeps measured usage when the process exits unsuccessfully after its result", () => {
    const r = run('MEASUREMENT {"usage":{"input_tokens":2,"output_tokens":3},"exitCode":1}');
    expect(r.exit).toBe(2);
    expect(r.calls[0]).toMatchObject({
      outcome: "failed",
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    expect(r.row.gate_decision).toBe("error");
  });
});
