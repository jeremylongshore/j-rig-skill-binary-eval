import { RequestPacer, requestPacingPolicy } from "../providers/request-pacing.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as core from "@j-rig/core";
import type { CostPolicy } from "@intentsolutions/refiner-core";
import { hashValue } from "@intentsolutions/refiner-core";
import type { JRigDatabase } from "@j-rig/db";
import * as storage from "../lib/db.js";
import {
  prepareEvaluationInvocation,
  startEvaluationModel,
  type EvalOptions,
} from "./eval-runtime-context.js";

const skill = fileURLToPath(new URL("../../../../skill", import.meta.url));
const roots: string[] = [];
const databases: JRigDatabase[] = [];
const keyNames = [
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
  "JRIG_COST_CONTEXT",
  "JRIG_BATCH_ID",
  "JRIG_BATCH_SKILL_RELATIVE_PATH",
  "JRIG_BATCH_MANIFEST",
];
beforeEach(() => {
  for (const name of keyNames) vi.stubEnv(name, undefined);
  vi.stubEnv("J_RIG_ALLOW_STUB", "1");
  vi.stubGlobal("__CLI_VERSION__", "0.5.1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const open = storage.openDb;
  vi.spyOn(storage, "openDb").mockImplementation((path) => {
    const database = open(path);
    databases.push(database);
    return database;
  });
  // No test in this file may reach a real provider. Individual transport cases install local responses.
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
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), "eval-runtime-"));
  roots.push(root);
  return root;
}
function options(root: string, extra: Partial<EvalOptions> = {}): EvalOptions {
  return {
    db: join(root, "eval.db"),
    spec: join(skill, "eval.yaml"),
    models: "sonnet",
    json: true,
    ...extra,
  };
}
function nativeEndpoint() {
  vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:1");
  vi.stubEnv("LLM_MODEL", "fixture-model");
}
function governedContext(root: string, maxFileMicros = 1_000_000) {
  const policy: CostPolicy = {
    schema: "refiner-cost-policy/v1",
    scopeId: "runtime-fixture",
    profile: "custom",
    source: "synthetic local rates",
    files: ["skill"],
    rates: [
      {
        provider: "openai",
        model: "fixture-model",
        reportedModels: ["fixture-model"],
        format: "openai",
        maxInputTokens: 100000,
        // The execution adapter requests its reviewed default 8192-token output ceiling.
        maxOutputTokens: 8192,
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
    maxFileMicros,
    maxTotalMicros: 2_000_000,
    meanFileBudgetMicros: 1_000_000,
    stopBasisPoints: 10000,
  };
  const context = {
    policyPath: join(root, "policy.json"),
    ledgerPath: join(root, "ledger.jsonl"),
    fileId: "skill",
    attemptId: "runtime-attempt",
  };
  writeFileSync(context.policyPath, JSON.stringify(policy));
  vi.stubEnv("JRIG_COST_CONTEXT", JSON.stringify(context));
  return { context, policy };
}

it.each([undefined, "anthropic"])(
  "starts the real Anthropic backend with provider preference=%s without making a request",
  async (provider) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key");
    const root = directory();
    const context = await prepareEvaluationInvocation(
      skill,
      options(root, { provider }),
      new Command(),
    );
    const state = startEvaluationModel(context, "sonnet");
    expect(state.providers).toMatchObject({
      real: true,
      providerName: "anthropic",
      judgeProviderName: "anthropic",
      judgeModelId: "claude-sonnet-4-6",
    });
    expect(state.correlation.evalRunId).toMatch(/^[a-f0-9-]{36}$/);
    expect(context.database.sqlite.prepare("SELECT status FROM runs").all()).toEqual([
      { status: "running" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("starts the unguided no-key stub fallback and honors a decoupled judge identity", async () => {
  const context = await prepareEvaluationInvocation(
    skill,
    options(directory(), { judgeProvider: "stub", judgeModel: "independent-judge" }),
    new Command(),
  );
  const state = startEvaluationModel(context, "sonnet");
  expect(state.providers).toMatchObject({
    real: false,
    providerName: "stub",
    judgeProviderName: "stub",
    judgeModelId: "independent-judge",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("retains explicit execution settings, trimmed batch lineage and content identities before startup", async () => {
  nativeEndpoint();
  vi.stubEnv("JRIG_BATCH_ID", " batch-1 ");
  vi.stubEnv("JRIG_BATCH_SKILL_RELATIVE_PATH", " skills/example ");
  vi.stubEnv("JRIG_BATCH_MANIFEST", " batch.json ");
  const context = await prepareEvaluationInvocation(
    skill,
    options(directory(), { provider: "openai", executionReasoningEffort: "none" }),
    new Command(),
  );
  expect(context.executionMetadata).toEqual({ execution_parameters: { reasoning_effort: "none" } });
  expect(context.batchLineage).toEqual({
    batch_id: "batch-1",
    batch_skill: "skills/example",
    batch_manifest: "batch.json",
  });
  expect(context.skillSnapshotSha).toBe(
    `sha256:${createHash("sha256")
      .update(readFileSync(join(skill, "SKILL.md")))
      .digest("hex")}`,
  );
  const state = startEvaluationModel(context, "sonnet");
  expect(state.providers.judgeModelId).toBe("fixture-model");
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { provider: "stub", functional: true },
  { provider: "openai", functional: false },
])("refuses an incompatible MCP boundary before file/database I/O: %j", async (settings) => {
  nativeEndpoint();
  await expect(
    prepareEvaluationInvocation(
      "/missing-skill",
      options(directory(), { ...settings, mcpConfig: "/missing-mcp.json" }),
      new Command(),
    ),
  ).rejects.toThrow("--mcp-config requires real functional execution");
  expect(storage.openDb).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("binds native wire usage to its real ledger and emitted cost correlation", async () => {
  const root = directory();
  nativeEndpoint();
  const configured = governedContext(root);
  const wire = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: "fixture-model",
          choices: [{ message: { content: "fixture response" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", wire);
  const context = await prepareEvaluationInvocation(
    skill,
    options(root, { provider: "openai", maxCalls: "10" }),
    new Command(),
  );
  const started = vi.spyOn(core, "emitRuntimeRunStarted");
  const state = startEvaluationModel(context, "fixture-model");
  expect(state.correlation).toMatchObject({
    refinerAttemptId: configured.context.attemptId,
    refinerFileId: "skill",
    refinerPolicyHash: hashValue(configured.policy),
    costRecordScope: "evaluator-run",
  });
  expect(started).toHaveBeenCalledWith(state.correlation, {
    specContentHash: context.specContentHash,
    skillSnapshotSha: context.skillSnapshotSha,
  });
  state.costMeter.phase = "execution";
  const result = await state.providers.execution.execute(
    "prompt",
    { skill_body: "fixture skill" },
    { model: "fixture-model" },
  );
  expect(result.text).toBe("fixture response");
  expect(wire).toHaveBeenCalledOnce();
  expect(context.costSession!.ledger.snapshot().total).toMatchObject({
    calls: 1,
    knownMicros: 15,
    committedTokens: 15,
    unknownCalls: 0,
  });
  expect(state.costMeter.report().total.calls).toBe(1);
});

it("records admission refusal before any network call without misclassifying it as provider failure", async () => {
  const root = directory();
  nativeEndpoint();
  governedContext(root, 1);
  const context = await prepareEvaluationInvocation(
    skill,
    options(root, { provider: "openai" }),
    new Command(),
  );
  const state = startEvaluationModel(context, "fixture-model");
  state.costMeter.phase = "judge";
  await expect(state.providers.judge.judge("criterion", "prompt", "output")).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(context.costSession!.refused).toEqual({ phase: "judge" });
  expect(context.costSession!.providerFailed).not.toBe(true);
});

it("a real failed wire attempt prevents later admission while retaining provider-failure attribution", async () => {
  const root = directory();
  nativeEndpoint();
  governedContext(root);
  const wire = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: { message: "fixture request rejected" } }), {
        status: 400,
      }),
  );
  vi.stubGlobal("fetch", wire);
  const context = await prepareEvaluationInvocation(
    skill,
    options(root, { provider: "openai" }),
    new Command(),
  );
  const state = startEvaluationModel(context, "fixture-model");
  await expect(
    state.providers.execution.execute("first", { skill_body: "fixture" }),
  ).rejects.toThrow();
  expect(context.costSession!.providerFailed).toBe(true);
  await expect(
    state.providers.execution.execute("second", { skill_body: "fixture" }),
  ).rejects.toThrow();
  expect(wire).toHaveBeenCalledOnce();
});

it.each(["stub", undefined])(
  "governed execution refuses a nonnative backend %s",
  async (provider) => {
    const root = directory();
    governedContext(root);
    const context = await prepareEvaluationInvocation(
      skill,
      options(root, { provider }),
      new Command(),
    );
    expect(() => startEvaluationModel(context, "sonnet")).toThrow(
      "Governed cost mode requires native providers",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("rejects subscription execution with a native shared cost policy before model startup", async () => {
  const root = directory();
  governedContext(root);
  await expect(
    prepareEvaluationInvocation(
      skill,
      options(root, { provider: "stub", executionProvider: "claude-code" }),
      new Command(),
    ),
  ).rejects.toThrow("Subscription execution cannot enforce native wire reservations");
  expect(fetch).not.toHaveBeenCalled();
});

it.each([false, true])(
  "meters the repository-owned subscription fixture with run-budget active=%s",
  async (limited) => {
    const root = directory();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const executable = join(bin, "claude");
    copyFileSync(
      fileURLToPath(
        new URL("../providers/__fixtures__/claude-code/fake-claude.mjs", import.meta.url),
      ),
      executable,
    );
    chmodSync(executable, 0o755);
    writeFileSync(
      join(root, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "synthetic-test-token", expiresAt: Date.now() + 3600000 },
      }),
    );
    vi.stubEnv("PATH", [bin, dirname(process.execPath)].join(delimiter));
    vi.stubEnv("CLAUDE_CONFIG_DIR", root);
    // Only the copied repository executable is on PATH; no live subscription binary is reachable.
    for (const marker of [
      "CI",
      "GITHUB_ACTIONS",
      "GITLAB_CI",
      "CIRCLECI",
      "BUILDKITE",
      "JENKINS_URL",
      "TF_BUILD",
      "TEAMCITY_VERSION",
      "BITBUCKET_BUILD_NUMBER",
      "CODEBUILD_BUILD_ID",
      "DRONE",
      "TRAVIS",
    ])
      vi.stubEnv(marker, undefined);
    const context = await prepareEvaluationInvocation(
      skill,
      options(root, {
        provider: "stub",
        executionProvider: "claude-code",
        ...(limited ? { maxTokens: "100000" } : {}),
      }),
      new Command(),
    );
    const state = startEvaluationModel(context, "claude-haiku-4-5");
    await state.providers.execution.execute(
      'MEASUREMENT {"noInit":true,"usage":{"input_tokens":0,"output_tokens":0}}',
      { skill_body: "fixture skill" },
    );
    const report = state.costMeter.report();
    expect(report.usage_evidence.calls).toHaveLength(1);
    expect(report.usage_evidence.calls[0]).toMatchObject({
      provider: "claude-code",
      outcome: "completed",
      requestedModel: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(report.billed_usd).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  },
  30000,
);

it("retains one pacing queue across model contexts and records the explicit policy", async () => {
  nativeEndpoint();
  const root = directory();
  const context = await prepareEvaluationInvocation(
    skill,
    options(root, { provider: "openai", judgeRequestsPerMinute: "60000" }),
    new Command(),
  );
  expect(context.executionMetadata).toMatchObject({
    request_pacing: {
      schema: "j-rig/request-pacing/v1",
      requests_per_minute: 60000,
      minimum_start_interval_ms: 1,
    },
  });
  const pacer = context.pacing;
  startEvaluationModel(context, "fixture-model");
  startEvaluationModel(context, "another-model");
  expect(context.pacing).toBe(pacer);
  expect(pacer).toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["0", "30\n", "invalid"])("rejects pacing %j before opening a database", async (rate) => {
  const root = directory();
  await expect(
    prepareEvaluationInvocation(
      skill,
      options(root, { judgeRequestsPerMinute: rate }),
      new Command(),
    ),
  ).rejects.toThrow(/judge-requests-per-minute/);
  expect(storage.openDb).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("paces actual native shared execution/judge dispatch across model contexts", async () => {
  nativeEndpoint();
  const root = directory();
  const context = await prepareEvaluationInvocation(
    skill,
    options(root, { provider: "openai", judgeRequestsPerMinute: "30" }),
    new Command(),
  );
  let time = 0;
  context.pacing = new RequestPacer(requestPacingPolicy("30")!, {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  const starts: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      starts.push(time);
      return new Response(
        JSON.stringify({
          model: "fixture-model",
          choices: [
            {
              message: {
                content: JSON.stringify({ verdict: "yes", confidence: 1, reasoning: "synthetic" }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    }),
  );
  const first = startEvaluationModel(context, "first-model");
  first.costMeter.phase = "execution";
  await first.providers.execution.execute("fixture", { skill_body: "fixture" });
  first.costMeter.phase = "judge";
  await first.providers.judge.judge("criterion-one", "fixture", "fixture");
  await first.providers.judge.judge("criterion-two", "fixture", "fixture");
  const second = startEvaluationModel(context, "second-model");
  second.costMeter.phase = "judge";
  await second.providers.judge.judge("criterion-one", "fixture", "fixture");
  expect(starts).toEqual([0, 2000, 4000, 6000]);
  expect(first.costMeter.report().total.calls).toBe(3);
  expect(second.costMeter.report().total.calls).toBe(1);
});

it("retains exact pacing policy and hash in a private SQLite-linked artifact without bundle output", async () => {
  nativeEndpoint();
  const root = directory();
  const context = await prepareEvaluationInvocation(
    skill,
    options(root, { provider: "openai", judgeRequestsPerMinute: "30" }),
    new Command(),
  );
  const model = startEvaluationModel(context, "fixture-model");
  const row = context.database.sqlite
    .prepare("SELECT * FROM artifacts WHERE run_id = ? AND artifact_type = 'request-pacing'")
    .get(model.runId) as { relative_path: string; size_bytes: number; sha256: string };
  const bytes = readFileSync(row.relative_path);
  expect(row.size_bytes).toBe(bytes.length);
  expect(row.sha256).toBe("sha256:" + createHash("sha256").update(bytes).digest("hex"));
  expect(statSync(row.relative_path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(row.relative_path)).mode & 0o777).toBe(0o700);
  expect(JSON.parse(bytes.toString())).toEqual({
    schema: "j-rig/request-pacing-receipt/v1",
    run_id: model.runId,
    policy: context.executionMetadata.request_pacing,
    judge: { provider: "openai", model: "fixture-model" },
  });
  expect(bytes.toString()).not.toContain("127.0.0.1");
  expect(bytes.toString()).not.toContain("synthetic-test-key");
  expect(fetch).not.toHaveBeenCalled();
});
it("failed artifact insertion cleans owned output and fails the run before dispatch", async () => {
  nativeEndpoint();
  const root = directory();
  const context = await prepareEvaluationInvocation(
    skill,
    options(root, { provider: "openai", judgeRequestsPerMinute: "30" }),
    new Command(),
  );
  context.database.sqlite.exec(
    "CREATE TRIGGER refuse_pacing BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'fixture artifact refusal'); END",
  );
  expect(() => startEvaluationModel(context, "fixture-model")).toThrow(
    "Unable to retain request pacing policy",
  );
  expect(context.database.sqlite.prepare("SELECT status FROM runs").all()).toEqual([
    { status: "failed" },
  ]);
  expect(context.database.sqlite.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({
    count: 0,
  });
  expect(readdirSync(root).filter((name) => name.includes(".pacing-"))).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
it("default-off startup does not create policy artifacts or metadata", async () => {
  nativeEndpoint();
  const root = directory();
  const context = await prepareEvaluationInvocation(
    skill,
    options(root, { provider: "openai" }),
    new Command(),
  );
  startEvaluationModel(context, "fixture-model");
  expect(context.executionMetadata).not.toHaveProperty("request_pacing");
  expect(
    context.database.sqlite
      .prepare("SELECT count(*) AS count FROM artifacts WHERE artifact_type = 'request-pacing'")
      .get(),
  ).toEqual({ count: 0 });
  expect(readdirSync(root).filter((name) => name.includes(".pacing-"))).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
