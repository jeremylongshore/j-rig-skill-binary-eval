import { afterEach, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDatabase, createRun, getOrCreateSkillVersion } from "@j-rig/db";
import { CriterionSchema, type ExecutionProvider } from "@j-rig/core";
import { loadSkillEvalSpec, loadSkillMd } from "../lib/loaders.js";
import { RunBudget } from "../providers/budget.js";
import { EvalCostMeter } from "../providers/cost-tracking.js";
import { evaluateNakedBaseline } from "./eval-baseline-phase.js";

afterEach(() => vi.restoreAllMocks());

function fixture(failFirst = false) {
  const spec = loadSkillEvalSpec(resolve("skill/eval.yaml"), resolve("skill"));
  spec.criteria = [
    CriterionSchema.parse({
      id: "target",
      description: "Target",
      method: "judge",
      judge_prompt: "Judge answer",
    }),
  ];
  spec.test_cases = ["first", "second"].map((id) => ({
    ...spec.test_cases[0]!,
    id,
    prompt: id,
    criteria_ids: ["target"],
  }));
  const skill = loadSkillMd(resolve("skill")).parsed;
  const database = createDatabase(":memory:");
  const costMeter = new EvalCostMeter();
  const phases: string[] = [];
  const execute = vi.fn<ExecutionProvider["execute"]>(async (prompt) => {
    phases.push(costMeter.phase);
    return {
      text: "answer",
      artifacts: [],
      tool_calls: 0,
      ...(failFirst && prompt === "first" ? { error: "provider failure" } : {}),
      meta: { started_at: "", completed_at: "", duration_ms: 0, timed_out: false },
    };
  });
  const judge = vi.fn(async () => {
    phases.push(costMeter.phase);
    return { verdict: "yes" as const, confidence: 1, reasoning: "fixture" };
  });
  const input: Parameters<typeof evaluateNakedBaseline>[0] = {
    spec,
    skill,
    database,
    costMeter,
    dbPath: ":memory:",
    runId: 1,
    json: true,
    providers: { execution: { execute }, judge: { judge }, judgeModelId: "judge-model" },
    model: "execution-model",
    toolReceipts: [],
    testCaseById: new Map(spec.test_cases.map((tc) => [tc.id, tc])),
    runBudget: new RunBudget({}, {}),
    judgeSamples: 1,
    allJudgments: [
      {
        criterion_id: "target",
        verdict: "yes",
        confidence: 1,
        reasoning: "skill",
        method: "judge",
      },
    ],
  };
  return { input, execute, judge, phases, dispose: () => database.sqlite.close() };
}

it("executes an empty skill body, preserves original inputs, and compares retained judgments", async () => {
  const f = fixture();
  const originalBody = f.input.skill.body;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    f.input.json = false;
    const result = await evaluateNakedBaseline(f.input);
    expect(f.execute).toHaveBeenCalledTimes(2);
    for (const call of f.execute.mock.calls) {
      expect(call[1].skill_body).toBe("");
      expect(call[2]).toMatchObject({ model: "execution-model", temperature: 0 });
    }
    expect(f.input.skill.body).toBe(originalBody);
    expect(f.phases).toEqual(["execution", "execution", "judge", "judge"]);
    expect(result.baselineOutcomes).toHaveLength(2);
    expect(result.baselineJudgments.map((j) => j.test_case_id)).toEqual(["first", "second"]);
    expect(result.isObsolete).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FLAGGED obsolete_review"));
  } finally {
    f.dispose();
  }
});

it.each([false, true])(
  "retains failed executions and applies active-budget suppression=%s",
  async (active) => {
    const f = fixture(true);
    try {
      if (active) f.input.runBudget = new RunBudget({ max_calls: 10 }, { max_calls: "run" });
      const result = await evaluateNakedBaseline(f.input);
      expect(result.baselineOutcomes).toHaveLength(2);
      expect(result.baselineOutcomes[0]!.output.error).toBe("provider failure");
      expect(f.judge).toHaveBeenCalledTimes(active ? 0 : 1);
      expect(result.baselineJudgments).toHaveLength(active ? 0 : 1);
    } finally {
      f.dispose();
    }
  },
);

it("keeps the baseline's existing skip behavior for unknown case IDs", async () => {
  const f = fixture();
  try {
    f.input.testCaseById.clear();
    const result = await evaluateNakedBaseline(f.input);
    expect(result.baselineOutcomes).toHaveLength(2);
    expect(result.baselineJudgments).toEqual([]);
    expect(f.judge).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

function toolArtifacts() {
  const session_id = randomUUID();
  return [
    { filename: "tool-session.json", data: { schema: "jrig-tool-session/v1", session_id } },
    {
      filename: "tool-observations.json",
      data: {
        schema: "jrig-tool-observations/v1",
        session_id,
        redaction: "known-environment-credentials-and-credential-fields/v1",
        calls: [
          { id: "save-1", tool: "host__save", arguments: {}, status: "completed", result: "saved" },
        ],
      },
    },
  ].map(({ filename, data }) => {
    const content = JSON.stringify(data);
    return { filename, type: "text" as const, content, size_bytes: Buffer.byteLength(content) };
  });
}

function toolFixture(observations: boolean) {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), "jrig-baseline-evidence-"));
  f.input.dbPath = join(root, "evidence.db");
  const version = getOrCreateSkillVersion(f.input.database, "skill", "1.0.0", "fixture");
  f.input.runId = createRun(f.input.database, version, "full", "execution-model");
  f.input.executionParameters = { reasoning_effort: "low" };
  f.input.toolConfig = {
    fingerprint: "a".repeat(64),
    runtime: {
      limits: {
        maxTurns: 2,
        maxCalls: 2,
        maxResultBytes: 1000,
        maxTotalBytes: 10000,
        timeoutMs: 1000,
      },
      ...(observations ? { judgeObservations: { redact: (text: string) => text } } : {}),
      open: async () => {
        throw new Error("fixture execution must not open an external tool");
      },
    },
  };
  f.execute.mockImplementation(async () => ({
    text: "answer",
    artifacts: toolArtifacts(),
    tool_calls: 1,
    meta: { started_at: "", completed_at: "", duration_ms: 0, timed_out: false },
  }));
  return {
    ...f,
    dispose: () => {
      f.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function storedToolReceipt(f: ReturnType<typeof toolFixture>) {
  const rows = f.input.database.sqlite
    .prepare(
      "SELECT run_id, relative_path, size_bytes, sha256 FROM artifacts WHERE artifact_type = 'tool-execution'",
    )
    .all();
  expect(rows).toHaveLength(1);
  const row = rows[0] as {
    run_id: number;
    relative_path: string;
    size_bytes: number;
    sha256: string;
  };
  const bytes = readFileSync(row.relative_path);
  expect(row.run_id).toBe(f.input.runId);
  expect(row.size_bytes).toBe(bytes.byteLength);
  expect(row.sha256).toBe("sha256:" + createHash("sha256").update(bytes).digest("hex"));
  expect(f.input.toolReceipts).toEqual([
    expect.objectContaining({
      phase: "baseline",
      sha256: row.sha256,
      cases: 2,
      completed_cases: 2,
      attempted_tool_calls: 2,
      execution_parameters: { reasoning_effort: "low" },
    }),
  ]);
  return JSON.parse(bytes.toString());
}

it.each([false, true])(
  "persists exact baseline tool evidence with judge observations=%s",
  async (observations) => {
    const f = toolFixture(observations);
    try {
      const result = await evaluateNakedBaseline(f.input);
      const receipt = storedToolReceipt(f);
      expect(receipt).toMatchObject({
        schema: "jrig-tool-execution/v1",
        run_id: f.input.runId,
        phase: "baseline",
        configuration_sha256: f.input.toolConfig!.fingerprint,
        execution_parameters: { reasoning_effort: "low" },
      });
      expect(receipt.cases.map((entry: { test_case_id: string }) => entry.test_case_id)).toEqual([
        "first",
        "second",
      ]);
      expect(f.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tool_runtime: f.input.toolConfig!.runtime,
        }),
        expect.objectContaining({ model: "execution-model", temperature: 0 }),
      );
      const content = result.baselineOutcomes[0]!.output.artifacts[1]!.content;
      expect(f.judge).toHaveBeenNthCalledWith(
        1,
        "Target",
        "first",
        "answer",
        "Judge answer",
        observations
          ? expect.objectContaining({ observations: content })
          : expect.not.objectContaining({ observations: expect.anything() }),
      );
      expect(receipt.judge_contexts?.[0]?.sha256).toBe(
        observations ? "sha256:" + createHash("sha256").update(content).digest("hex") : undefined,
      );
    } finally {
      f.dispose();
    }
  },
);
