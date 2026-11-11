import { afterEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { createDatabase } from "@j-rig/db";
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
