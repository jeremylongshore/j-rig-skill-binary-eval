import {
  runFunctionalTests,
  selectCriteriaForTestCase,
  judgeCriteria,
  compareBaseline,
  isObsoleteCandidate,
  type JudgmentResult,
  type ExecutionProvider,
  type JudgeProvider,
  type ReasoningEffort,
} from "@j-rig/core";
import type { ParsedSkill, SkillEvalSpec } from "../lib/loaders.js";
import type { EvalCostMeter } from "../providers/cost-tracking.js";
import type { RunBudget } from "../providers/budget.js";
import type { loadMcpRuntime } from "../execution/mcp-runtime.js";
import { getJudgeObservations, storeToolExecutionEvidence } from "../execution/evidence.js";
import { isFailedExecution } from "./eval-infrastructure-failure.js";

interface BaselineInput {
  spec: SkillEvalSpec;
  skill: ParsedSkill;
  providers: { execution: ExecutionProvider; judge: JudgeProvider; judgeModelId: string };
  model: string;
  costMeter: EvalCostMeter;
  database: Parameters<typeof storeToolExecutionEvidence>[0];
  dbPath: string;
  runId: number;
  json?: boolean;
  toolConfig?: Awaited<ReturnType<typeof loadMcpRuntime>>;
  toolReceipts: ReturnType<typeof storeToolExecutionEvidence>[];
  executionParameters?: { reasoning_effort: ReasoningEffort };
  testCaseById: Map<string, SkillEvalSpec["test_cases"][number]>;
  runBudget: RunBudget;
  judgeSamples?: number;
  allJudgments: JudgmentResult[];
}

/** Execute and judge the naked model while retaining observations for failure classification. */
export async function evaluateNakedBaseline(input: BaselineInput) {
  const {
    spec,
    skill,
    providers,
    model,
    costMeter,
    database,
    runId,
    toolConfig,
    toolReceipts,
    executionParameters,
    testCaseById,
    runBudget,
    judgeSamples,
    allJudgments,
    dbPath,
    json,
  } = input;
  costMeter.phase = "execution";
  const nakedOutcomes = await runFunctionalTests(
    spec.test_cases,
    { ...skill, body: "" },
    providers.execution,
    {
      model,
      temperature: spec.execution_temperature ?? 0,
      ...(toolConfig ? { tool_runtime: toolConfig.runtime } : {}),
    },
  );
  costMeter.phase = "judge";
  const nakedJudgments: JudgmentResult[] = [];
  const baselineOutcomes = nakedOutcomes;
  if (toolConfig) {
    toolReceipts.push(
      storeToolExecutionEvidence(
        database,
        dbPath,
        runId,
        "baseline",
        toolConfig.fingerprint,
        nakedOutcomes,
        !!toolConfig.runtime.judgeObservations,
        toolConfig.runtime.limits.maxTotalBytes,
        executionParameters,
      ),
    );
  }
  const baselineJudgments = nakedJudgments;
  const baselineExecutionFailed = nakedOutcomes.some(isFailedExecution);
  for (const outcome of nakedOutcomes) {
    if (runBudget.active && baselineExecutionFailed) break;
    if (isFailedExecution(outcome)) continue;
    const testCase = testCaseById.get(outcome.test_case_id);
    if (!testCase) continue;
    const nakedCriteria = selectCriteriaForTestCase(spec.criteria, testCase.criteria_ids);
    const judgments = await judgeCriteria(nakedCriteria, outcome, providers.judge, {
      ...(toolConfig?.runtime.judgeObservations
        ? {
            observations: getJudgeObservations(
              outcome,
              true,
              toolConfig.runtime.limits.maxTotalBytes,
            ),
          }
        : {}),
      model: providers.judgeModelId,
      samples: judgeSamples,
      judgeTemperature: spec.judge_temperature,
      judgeTimeoutMs: spec.judge_timeout_ms,
      sampleConcurrency: spec.judge_sample_concurrency,
    });
    nakedJudgments.push(...judgments.map((j) => ({ ...j, test_case_id: outcome.test_case_id })));
  }
  const baselineComparisons = compareBaseline(allJudgments, nakedJudgments);
  const isObsolete = isObsoleteCandidate(baselineComparisons);
  if (!json) {
    const adds = baselineComparisons.filter((c) => c.skill_adds_value).length;
    console.log(
      `  Baseline: skill adds value on ${adds}/${baselineComparisons.length} criteria` +
        (isObsolete ? " — FLAGGED obsolete_review (little value over the naked model)" : ""),
    );
  }
  return { baselineOutcomes, baselineJudgments, baselineComparisons, isObsolete };
}
