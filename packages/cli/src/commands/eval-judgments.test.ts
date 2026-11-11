import { afterEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import {
  CriterionSchema,
  emitJudgeInvoked,
  emitJudgeVerdict,
  emitRuntimeCriterionEvaluated,
  type ObservedOutcome,
} from "@j-rig/core";
import { loadSkillEvalSpec } from "../lib/loaders.js";
import { RunBudget } from "../providers/budget.js";
import { evaluateOutcomeJudgments } from "./eval-judgments.js";

vi.mock("@j-rig/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@j-rig/core")>()),
  emitJudgeInvoked: vi.fn(),
  emitJudgeVerdict: vi.fn(),
  emitRuntimeCriterionEvaluated: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

function outcome(id = "case"): ObservedOutcome {
  return {
    test_case_id: id,
    prompt: "test",
    output: { text: "answer", artifacts: [], tool_calls: 0 },
    meta: { started_at: "", completed_at: "", duration_ms: 0, timed_out: false },
    status: "completed",
  };
}
function fixture(verdict: "yes" | "no" | "unsure" = "yes") {
  const spec = loadSkillEvalSpec(resolve("skill/eval.yaml"), resolve("skill"));
  spec.criteria = [
    CriterionSchema.parse({
      id: "target",
      description: "Target",
      method: "judge",
      judge_prompt: "Judge answer",
    }),
    CriterionSchema.parse({
      id: "unrelated",
      description: "Unrelated",
      method: "judge",
      judge_prompt: "Not selected",
    }),
  ];
  spec.test_cases = [{ ...spec.test_cases[0]!, id: "case", criteria_ids: ["target"] }];
  const judge = vi.fn(async () => ({ verdict, confidence: 1, reasoning: "fixture" }));
  const input: Parameters<typeof evaluateOutcomeJudgments>[0] = {
    outcomes: [outcome()],
    spec,
    testCaseById: new Map(spec.test_cases.map((tc) => [tc.id, tc])),
    providers: { judge: { judge }, judgeModelId: "judge-model" },
    model: "execution-model",
    skillVersion: "1.0.0",
    judgeSamples: 2,
    correlation: { evalRunId: "019a6f90-0000-7000-8000-000000000001" },
    runBudget: new RunBudget({}, {}),
  };
  return { input, judge };
}

it.each(["yes", "no", "unsure"] as const)(
  "retains scoped %s judgments, case identity and per-sample telemetry",
  async (verdict) => {
    const { input, judge } = fixture(verdict);
    const result = await evaluateOutcomeJudgments(input);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(result.allJudgments).toHaveLength(1);
    expect(result.allJudgments[0]).toMatchObject({
      criterion_id: "target",
      test_case_id: "case",
      verdict,
      judge_model: "judge-model",
      sample_verdicts: [verdict, verdict],
    });
    expect(result.runHadFailure).toBe(verdict === "no");
    expect(emitJudgeInvoked).toHaveBeenCalledTimes(2);
    expect(emitJudgeInvoked).toHaveBeenCalledWith(input.correlation, {
      judgeId: "j-rig:judge:target",
      modelId: "judge-model",
      modelVersion: "1.0.0",
    });
    expect(emitJudgeVerdict).toHaveBeenCalledTimes(2);
    expect(emitRuntimeCriterionEvaluated).toHaveBeenCalledTimes(1);
  },
);

it("throws on an unknown test-case ID without falling back to all criteria", async () => {
  const { input, judge } = fixture();
  input.outcomes = [outcome("missing")];
  await expect(evaluateOutcomeJudgments(input)).rejects.toThrow(
    'Outcome references unknown test case id: "missing"',
  );
  expect(judge).not.toHaveBeenCalled();
});

it.each([false, true])("preserves execution failure with budget active=%s", async (active) => {
  const { input, judge } = fixture();
  const failed = outcome();
  failed.output.error = "provider failed";
  input.outcomes = [failed, outcome()];
  if (active) input.runBudget = new RunBudget({ max_calls: 10 }, { max_calls: "run" });
  const result = await evaluateOutcomeJudgments(input);
  expect(judge).toHaveBeenCalledTimes(active ? 0 : 2);
  expect(result.allJudgments).toHaveLength(active ? 0 : 1);
});

it("does not invoke the judge after a budget stop has latched", async () => {
  const { input, judge } = fixture();
  input.runBudget = new RunBudget({ max_wall_ms: 0 }, { max_wall_ms: "run" });
  input.runBudget.check();
  expect(input.runBudget.stop).not.toBeNull();
  expect(await evaluateOutcomeJudgments(input)).toEqual({ allJudgments: [], runHadFailure: false });
  expect(judge).not.toHaveBeenCalled();
});

it("emits criterion evidence for deterministic checks without judge events", async () => {
  const { input, judge } = fixture();
  input.spec.criteria = [
    CriterionSchema.parse({
      id: "target",
      description: "Nonempty",
      method: "deterministic",
      deterministic_check: "not_empty",
    }),
  ];
  const result = await evaluateOutcomeJudgments(input);
  expect(result.allJudgments[0]).toMatchObject({
    method: "deterministic",
    verdict: "yes",
    test_case_id: "case",
  });
  expect(result.runHadFailure).toBe(false);
  expect(judge).not.toHaveBeenCalled();
  expect(emitJudgeInvoked).not.toHaveBeenCalled();
  expect(emitRuntimeCriterionEvaluated).toHaveBeenCalledTimes(1);
});

it("keeps the single-sample invoked/verdict pair", async () => {
  const { input, judge } = fixture();
  input.judgeSamples = 1;
  const result = await evaluateOutcomeJudgments(input);
  expect(judge).toHaveBeenCalledTimes(1);
  expect(result.allJudgments[0]).toMatchObject({ verdict: "yes", test_case_id: "case" });
  expect(emitJudgeInvoked).toHaveBeenCalledTimes(1);
  expect(emitJudgeVerdict).toHaveBeenCalledTimes(1);
});
