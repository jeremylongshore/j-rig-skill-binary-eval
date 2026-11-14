import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import * as core from "@j-rig/core";
import type { JRigDatabase } from "@j-rig/db";
import * as db from "@j-rig/db";
import * as storage from "../lib/db.js";
import { StubExecutionProvider, StubJudgeProvider } from "../providers/anthropic.js";
import { registerEvalCommand } from "./eval.js";
import { prepareEvaluationInvocation } from "./eval-runtime-context.js";
import { evaluateSingleModel } from "./eval-model-run.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const skill = fileURLToPath(new URL("../../../../skill", import.meta.url));
const roots: string[] = [];
const databases: JRigDatabase[] = [];
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.stubEnv("J_RIG_ALLOW_STUB", "1");
  vi.stubGlobal("__CLI_VERSION__", "0.5.1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const realOpenDb = storage.openDb;
  vi.spyOn(storage, "openDb").mockImplementation((path) => {
    const database = realOpenDb(path);
    databases.push(database);
    return database;
  });
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function paths() {
  const root = mkdtempSync(join(tmpdir(), "eval-coordination-"));
  roots.push(root);
  return {
    root,
    db: join(root, "eval.db"),
    bundle: join(root, "bundle.json"),
    rollout: join(root, "rollout.json"),
  };
}

// Preserve terminal failures while exposing the diagnostic the command wrote before exit.
async function invoke(
  program: Command,
  args: string[],
  options: Parameters<Command["parseAsync"]>[1],
) {
  try {
    await program.parseAsync(args, options);
  } catch (error) {
    throw new Error(`Command failed: ${JSON.stringify(vi.mocked(console.error).mock.calls)}`, {
      cause: error,
    });
  }
}

it.each([false, true])(
  "registered eval preserves two-model evidence, metadata and terminal events with JSON=%s",
  async (json) => {
    const p = paths();
    const started = vi.spyOn(core, "emitRuntimeRunStarted");
    const finished = vi.spyOn(core, "emitRuntimeRunFinished");
    const gate = vi.spyOn(core, "emitGateDecisionEmitted");
    const program = new Command();
    registerEvalCommand(program);
    await invoke(
      program,
      [
        "eval",
        skill,
        "--spec",
        join(skill, "eval.yaml"),
        "--provider",
        "stub",
        "--models",
        "sonnet,haiku",
        "--db",
        p.db,
        "--emit-bundle",
        p.bundle,
        "--rollout-file",
        p.rollout,
        ...(json ? ["--json"] : []),
      ],
      { from: "user" },
    );
    const bytes = readFileSync(p.bundle);
    const statements = core.EvidenceStatementSchema.array().parse(JSON.parse(bytes.toString()));
    expect(statements).toHaveLength(2);
    expect(statements.map((row) => row.predicate.metadata?.model)).toEqual(["sonnet", "haiku"]);
    expect(statements.map((row) => row.predicate.metadata?.ground_truth)).toEqual([false, false]);
    expect(started).toHaveBeenCalledTimes(2);
    expect(gate).toHaveBeenCalledTimes(2);
    expect(finished).toHaveBeenCalledTimes(2);
    expect(finished.mock.calls.map(([correlation]) => correlation)).toEqual(
      started.mock.calls.map(([correlation]) => correlation),
    );
    const database = databases[0]!;
    expect(database.sqlite.prepare("SELECT status FROM runs ORDER BY id").all()).toEqual([
      { status: "completed" },
      { status: "completed" },
    ]);
    const expectedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    expect(
      database.sqlite
        .prepare("SELECT sha256 FROM artifacts WHERE artifact_type = 'evidence-bundle'")
        .all(),
    ).toEqual([{ sha256: expectedDigest }, { sha256: expectedDigest }]);
    expect(JSON.parse(readFileSync(p.rollout, "utf8")).runs).toHaveLength(2);
    expect(process.exitCode).toBe(0);
  },
);

it("coordinates baseline and regression before completing a model and preserves promotion hashes", async () => {
  const p = paths();
  const previous = join(p.root, "previous.json");
  writeFileSync(previous, "[]\n");
  const command = new Command().setOptionValueWithSource("models", "sonnet", "cli");
  const context = await prepareEvaluationInvocation(
    skill,
    {
      spec: join(skill, "eval.yaml"),
      db: p.db,
      models: "sonnet",
      provider: "stub",
      json: true,
      baselineCheck: true,
      regressionBaseline: previous,
      emitBundle: p.bundle,
    },
    command,
  );
  const result = await evaluateSingleModel(context, "sonnet");
  expect(result).toEqual({ status: "completed", infrastructureFailureSeen: false });
  expect(context.bundleRows).toHaveLength(1);
  const metadata = context.bundleRows[0]!.predicate.metadata;
  expect(metadata?.regression).toMatchObject({
    enabled: true,
    baseline_sha256: `sha256:${createHash("sha256").update(readFileSync(previous)).digest("hex")}`,
  });
  expect(context.bundleRows[0]!.predicate.coverage.dimensions_evaluated).toContain("baseline");
  expect(context.bundleRows[0]!.predicate.coverage.dimensions_evaluated).toContain("regression");
  expect(
    context.database.sqlite.prepare("SELECT criterion_id FROM criterion_results ORDER BY id").all(),
  ).toEqual([
    { criterion_id: "output-not-empty" },
    { criterion_id: "mentions-ship-decision" },
    { criterion_id: "separates-evaluator-from-skill" },
    { criterion_id: "output-not-empty" },
    { criterion_id: "mentions-ship-decision" },
    { criterion_id: "output-not-empty" },
    { criterion_id: "no-prompt-leakage" },
  ]);
  expect(context.database.sqlite.prepare("SELECT total FROM run_summaries").all()).toEqual([
    { total: 7 },
  ]);
});

it.each([false, true])(
  "trigger-only coordination produces no functional evidence with routing enabled=%s",
  async (trigger) => {
    const p = paths();
    const context = await prepareEvaluationInvocation(
      skill,
      {
        spec: join(skill, "eval.yaml"),
        db: p.db,
        models: "sonnet",
        provider: "stub",
        json: true,
        functional: false,
        trigger,
      },
      new Command(),
    );
    const result = await evaluateSingleModel(context, "sonnet");
    expect(result).toEqual({ status: "completed", infrastructureFailureSeen: false });
    expect(context.allResults.sonnet).toMatchObject({ functional_skipped: true, cost: null });
    expect(context.bundleRows).toEqual([]);
    expect(context.database.sqlite.prepare("SELECT status FROM runs").get()).toEqual({
      status: "completed",
    });
  },
);

it("preserves an execution outage as infrastructure error instead of promotion", async () => {
  const p = paths();
  vi.spyOn(StubExecutionProvider.prototype, "execute").mockRejectedValue(
    new core.ProviderError({
      providerName: "fixture",
      category: "network_timeout",
      retryable: true,
      message: "fixture offline",
    }),
  );
  const context = await prepareEvaluationInvocation(
    skill,
    {
      spec: join(skill, "eval.yaml"),
      db: p.db,
      models: "sonnet",
      provider: "stub",
      json: true,
      emitBundle: p.bundle,
    },
    new Command(),
  );
  expect(await evaluateSingleModel(context, "sonnet")).toEqual({
    status: "completed",
    infrastructureFailureSeen: true,
  });
  expect(context.allResults.sonnet).toMatchObject({
    gate_decision: "error",
    evaluation_error: { phase: "execution" },
  });
  expect(context.allResults.sonnet).not.toHaveProperty("promotion");
  expect(context.bundleRows[0]!.predicate.gate_decision).toBe("error");
  expect(context.database.sqlite.prepare("SELECT status FROM runs").get()).toEqual({
    status: "failed",
  });
});

it("registered eval reports infrastructure exitCode without a second exit or unexpected error", async () => {
  const p = paths();
  const exit = vi.spyOn(process, "exit");
  vi.spyOn(StubJudgeProvider.prototype, "judge").mockRejectedValue(
    new Error("fixture judge unavailable"),
  );
  const program = new Command();
  registerEvalCommand(program);
  await invoke(
    program,
    [
      "eval",
      skill,
      "--spec",
      join(skill, "eval.yaml"),
      "--provider",
      "stub",
      "--models",
      "sonnet",
      "--db",
      p.db,
      "--json",
    ],
    { from: "user" },
  );
  expect(process.exitCode).toBe(2);
  expect(exit).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalledWith(expect.stringMatching(/^Error:/));
});

it.each(["trigger", "judge", "baseline"] as const)(
  "budget stop after %s preserves phase-specific storage and emits no gate verdict",
  async (phase) => {
    const p = paths();
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const context = await prepareEvaluationInvocation(
      skill,
      {
        spec: join(skill, "eval.yaml"),
        db: p.db,
        models: "sonnet",
        provider: "stub",
        json: true,
        maxWallMs: "1",
        baselineCheck: true,
        emitBundle: p.bundle,
      },
      new Command(),
    );
    vi.spyOn(core, "emitRuntimeRunStarted").mockImplementation(() => {
      if (phase === "trigger") now = 2;
    });
    const originalJudge = StubJudgeProvider.prototype.judge;
    vi.spyOn(StubJudgeProvider.prototype, "judge").mockImplementation(async function (
      this: StubJudgeProvider,
      ...args
    ) {
      if (phase === "judge") now = 2;
      return originalJudge.apply(this, args);
    });
    let executions = 0;
    const originalExecute = StubExecutionProvider.prototype.execute;
    vi.spyOn(StubExecutionProvider.prototype, "execute").mockImplementation(async function (
      this: StubExecutionProvider,
      ...args
    ) {
      executions++;
      if (phase === "baseline" && executions > context.spec.test_cases.length) now = 2;
      return originalExecute.apply(this, args);
    });
    const gate = vi.spyOn(core, "emitGateDecisionEmitted");
    const finished = vi.spyOn(core, "emitRuntimeRunFinished");
    expect(await evaluateSingleModel(context, "sonnet")).toEqual({ status: "budget-stopped" });
    expect(context.bundleRows).toEqual([]);
    expect(context.bundleRunIds).toEqual([]);
    expect(gate).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledOnce();
    expect(finished.mock.calls[0]![1].terminalState).toBe(
      core.RuntimeTerminalState.ARCHIVED_FAILED,
    );
    expect(context.database.sqlite.prepare("SELECT status FROM runs").all()).toEqual([
      { status: "failed" },
    ]);
    expect(
      context.database.sqlite.prepare("SELECT count(*) AS n FROM criterion_results").get(),
    ).toEqual({ n: phase === "baseline" ? 7 : 0 });
    expect(context.allResults.sonnet).toMatchObject({ budget_stop: { limit: "max_wall_ms" } });
  },
);

it("registered budget stop skips later models and finalizes exitCode3 without inventing evidence", async () => {
  const p = paths();
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const started = vi.spyOn(core, "emitRuntimeRunStarted").mockImplementation(() => {
    now = 2;
  });
  const exit = vi.spyOn(process, "exit");
  const program = new Command();
  registerEvalCommand(program);
  await invoke(
    program,
    [
      "eval",
      skill,
      "--spec",
      join(skill, "eval.yaml"),
      "--provider",
      "stub",
      "--models",
      "sonnet,haiku",
      "--db",
      p.db,
      "--max-wall-ms",
      "1",
      "--json",
      "--emit-bundle",
      p.bundle,
    ],
    { from: "user" },
  );
  expect(started).toHaveBeenCalledOnce();
  expect(databases[0]!.sqlite.prepare("SELECT model, status FROM runs").all()).toEqual([
    { model: "sonnet", status: "failed" },
  ]);
  expect(process.exitCode).toBe(3);
  expect(exit).not.toHaveBeenCalled();
  const output = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);
  expect(output.haiku).toMatchObject({ skipped: "budget_exhausted" });
  expect(existsSync(p.bundle)).toBe(false);
});

it("runs a declared self-test once and folds its failure into both models before persistence", async () => {
  const p = paths();
  const copied = join(p.root, "skill");
  cpSync(skill, copied, { recursive: true });
  writeFileSync(
    join(copied, "self-test.cjs"),
    'require("node:fs").appendFileSync("executions", "run\\n"); process.exitCode=1;',
  );
  const specPath = join(p.root, "spec.yaml");
  const spec = parse(readFileSync(join(skill, "eval.yaml"), "utf8"));
  writeFileSync(
    specPath,
    stringify({
      ...spec,
      self_test: { command: "node self-test.cjs", expect_exit: 0, blocker: true },
    }),
  );
  const program = new Command();
  registerEvalCommand(program);
  await invoke(
    program,
    [
      "eval",
      copied,
      "--spec",
      specPath,
      "--provider",
      "stub",
      "--models",
      "sonnet,haiku",
      "--db",
      p.db,
      "--run-self-test",
      "--json",
    ],
    { from: "user" },
  );
  expect(readFileSync(join(copied, "executions"), "utf8")).toBe("run\n");
  expect(
    databases[0]!.sqlite
      .prepare(
        "SELECT criterion_id, passed FROM criterion_results WHERE criterion_id='self-test' ORDER BY id",
      )
      .all(),
  ).toEqual([
    { criterion_id: "self-test", passed: 0 },
    { criterion_id: "self-test", passed: 0 },
  ]);
  expect(
    databases[0]!.sqlite.prepare("SELECT total, errors FROM run_summaries ORDER BY id").all(),
  ).toEqual([
    { total: 8, errors: 1 },
    { total: 8, errors: 1 },
  ]);
});

it.each([false, true])(
  "registered local HTTP/MCP evaluation retains execution evidence and refusal=%s",
  async (refuse) => {
    const p = paths();
    const fixture = fileURLToPath(
      new URL("../execution/__fixtures__/mcp-server.mjs", import.meta.url),
    );
    const server = createServer(async (request, response) => {
      // Port probes are not model requests and carry no JSON body.
      if (request.method !== "POST" || request.url !== "/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        tools?: unknown[];
        messages: { role: string; content: string }[];
      };
      const needsTool = Boolean(
        body.tools && !body.messages.some((message) => message.role === "tool"),
      );
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: needsTool ? "tool_calls" : "stop",
              message: needsTool
                ? {
                    content: "",
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: {
                          name: refuse ? "fixture__missing" : "fixture__echo",
                          arguments: JSON.stringify({ text: "retained fixture" }),
                        },
                      },
                    ],
                  }
                : {
                    content: body.tools
                      ? "grounded fixture answer"
                      : JSON.stringify({
                          verdict: "yes",
                          confidence: 1,
                          reasoning: "fixture judgment",
                        }),
                  },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("fixture must bind loopback TCP");
      vi.stubEnv("OPENAI_API_KEY", "synthetic-fixture-key");
      vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${address.port}`);
      vi.stubEnv("LLM_MODEL", "fixture-model");
      vi.stubEnv("MCP_FIXTURE_DIR", p.root);
      const spec = parse(readFileSync(join(skill, "eval.yaml"), "utf8"));
      spec.test_cases = [spec.test_cases[0]];
      spec.criteria = [spec.criteria[1]];
      spec.test_cases[0].criteria_ids = [spec.criteria[0].id];
      const specPath = join(p.root, "spec.yaml");
      writeFileSync(specPath, stringify(spec));
      const config = join(p.root, "mcp.json");
      writeFileSync(
        config,
        JSON.stringify({
          servers: {
            fixture: {
              command: process.execPath,
              args: [fixture],
              env: ["MCP_FIXTURE_DIR"],
              tools: ["echo"],
            },
          },
        }),
      );
      const program = new Command();
      registerEvalCommand(program);
      await invoke(
        program,
        [
          "eval",
          skill,
          "--spec",
          specPath,
          "--provider",
          "openai",
          "--models",
          "fixture-model",
          "--no-trigger",
          "--baseline-check",
          "--mcp-config",
          config,
          "--db",
          p.db,
          "--emit-bundle",
          p.bundle,
          "--rollout-file",
          p.rollout,
          "--trace-boundary",
          "--max-calls",
          "100",
        ],
        { from: "user" },
      );
      expect(process.exitCode).toBe(refuse ? 2 : 0);
      const statements = core.EvidenceStatementSchema.array().parse(
        JSON.parse(readFileSync(p.bundle, "utf8")),
      );
      expect(statements[0]!.predicate.gate_decision).toBe(refuse ? "error" : "advisory");
      expect(statements[0]!.predicate.metadata).toMatchObject({
        provider: "openai",
        ground_truth: true,
      });
      const artifacts = databases[0]!.sqlite
        .prepare("SELECT artifact_type FROM artifacts WHERE artifact_type='tool-execution'")
        .all();
      expect(artifacts).toHaveLength(refuse ? 1 : 2);
      expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("[boundary]");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  30000,
);

it.each(["summary", "gate"] as const)(
  "a %s exception aborts completion without a terminal-success event",
  async (site) => {
    const p = paths();
    const context = await prepareEvaluationInvocation(
      skill,
      {
        spec: join(skill, "eval.yaml"),
        db: p.db,
        models: "sonnet",
        provider: "stub",
        json: true,
        emitBundle: p.bundle,
        rolloutFile: p.rollout,
      },
      new Command(),
    );
    const failure = new Error(`${site} unavailable`);
    if (site === "summary")
      vi.spyOn(db, "storeRunSummary").mockImplementation(() => {
        throw failure;
      });
    if (site === "gate")
      vi.spyOn(core, "emitGateDecisionEmitted").mockImplementation(() => {
        throw failure;
      });
    const finished = vi.spyOn(core, "emitRuntimeRunFinished");
    await expect(evaluateSingleModel(context, "sonnet")).rejects.toBe(failure);
    expect(context.database.sqlite.prepare("SELECT status FROM runs").all()).toEqual([
      { status: "running" },
    ]);
    expect(
      context.database.sqlite.prepare("SELECT count(*) AS n FROM criterion_results").get(),
    ).toEqual({ n: 7 });
    expect(context.bundleRows).toEqual([]);
    expect(context.bundleRunIds).toEqual([]);
    expect(context.retainedRollouts).toEqual([]);
    expect(finished).not.toHaveBeenCalled();
    expect(Object.keys(context.allResults)).toEqual(site === "gate" ? ["sonnet"] : []);
  },
);

it.each([
  {
    name: "UTF-8",
    original: Buffer.from('[{"criterion_id":"mentions-ship-decision","verdict":"yes"}]\n'),
  },
  {
    name: "replacement-decoded UTF-8",
    original: Buffer.concat([
      Buffer.from('[{"criterion_id":"mentions-ship-decision","verdict":"yes","note":"'),
      Buffer.from([0xff]),
      Buffer.from('"}]\n'),
    ]),
  },
])(
  "binds regression evidence to the original $name bytes despite replacement",
  async ({ original }) => {
    const p = paths();
    const previous = join(p.root, "previous.json");
    const replacement = '[{"criterion_id":"mentions-ship-decision","verdict":"no"}]\n';
    writeFileSync(previous, original);
    const realRead = (await vi.importActual<typeof import("node:fs")>("node:fs")).readFileSync;
    let baselineReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((path, options) => {
      const bytes = realRead(path, options);
      if (path === previous) {
        baselineReads++;
        writeFileSync(previous, replacement);
      }
      return bytes;
    });
    const context = await prepareEvaluationInvocation(
      skill,
      {
        spec: join(skill, "eval.yaml"),
        db: p.db,
        models: "sonnet",
        provider: "stub",
        json: true,
        regressionBaseline: previous,
        emitBundle: p.bundle,
      },
      new Command(),
    );
    expect(await evaluateSingleModel(context, "sonnet")).toEqual({
      status: "completed",
      infrastructureFailureSeen: false,
    });
    expect(context.bundleRows[0]!.predicate.metadata?.regression).toMatchObject({
      enabled: true,
      baseline_sha256: `sha256:${createHash("sha256").update(original).digest("hex")}`,
    });
    expect(baselineReads).toBe(1);
    expect(realRead(previous, "utf8")).toBe(replacement);
  },
);

it("keeps partial-outage diagnostic ship results separate from every authoritative error boundary", async () => {
  const p = paths();
  const execution = vi.spyOn(StubExecutionProvider.prototype, "execute").mockRejectedValueOnce(
    new core.ProviderError({
      providerName: "fixture",
      category: "network_timeout",
      retryable: true,
      message: "one execution unavailable",
    }),
  );
  const gate = vi.spyOn(core, "emitGateDecisionEmitted");
  const program = new Command();
  registerEvalCommand(program);
  await invoke(
    program,
    [
      "eval",
      skill,
      "--spec",
      join(skill, "eval.yaml"),
      "--provider",
      "stub",
      "--models",
      "sonnet",
      "--db",
      p.db,
      "--json",
      "--emit-bundle",
      p.bundle,
    ],
    { from: "user" },
  );
  expect(execution).toHaveBeenCalledTimes(4);
  const output = vi
    .mocked(console.log)
    .mock.calls.map(([value]) => value)
    .find((value) => typeof value === "string" && value.startsWith("{\n"));
  const results = JSON.parse(String(output));
  expect(results.sonnet).toMatchObject({
    gate_decision: "error",
    decision: "ship",
    report: { decision: "ship" },
    evaluation_error: { phase: "execution", affected: 1, total: 4 },
  });
  expect(results.sonnet).not.toHaveProperty("promotion");
  const [statement] = core.EvidenceStatementSchema.array().parse(
    JSON.parse(readFileSync(p.bundle, "utf8")),
  );
  expect(statement!.predicate.gate_decision).toBe("error");
  expect(statement!.predicate.metadata?.error_detail).toMatchObject({
    phase: "execution",
    affected: 1,
    total: 4,
  });
  expect(databases[0]!.sqlite.prepare("SELECT status FROM runs").get()).toEqual({
    status: "failed",
  });
  expect(gate).toHaveBeenCalledTimes(1);
  expect(gate.mock.calls[0]![1]).toMatchObject({ decision: "error" });
  expect(process.exitCode).toBe(2);
});
