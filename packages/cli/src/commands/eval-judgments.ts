import {
  judgeCriteria,
  selectCriteriaForTestCase,
  emitJudgeInvoked,
  emitJudgeVerdict,
  emitRuntimeCriterionEvaluated,
  JudgeVerdictSource,
  CriterionOutcome,
  type ObservedOutcome,
  type JudgmentResult,
  type JudgeProvider,
  type EvalCorrelation,
} from "@j-rig/core";
import type { SkillEvalSpec } from "../lib/loaders.js";
import type { RunBudget } from "../providers/budget.js";
import type { loadMcpRuntime } from "../execution/mcp-runtime.js";
import { getJudgeObservations } from "../execution/evidence.js";
import { isFailedExecution } from "./eval-infrastructure-failure.js";

interface JudgmentInput {
  outcomes: ObservedOutcome[];
  spec: SkillEvalSpec;
  testCaseById: Map<string, SkillEvalSpec["test_cases"][number]>;
  providers: { judge: JudgeProvider; judgeModelId: string };
  model: string;
  skillVersion: string;
  judgeSamples?: number;
  correlation: EvalCorrelation;
  runBudget: RunBudget;
  costSession?: { refused?: { phase: "trigger" | "execution" | "judge" } };
  toolConfig?: Awaited<ReturnType<typeof loadMcpRuntime>>;
}

export async function evaluateOutcomeJudgments(input: JudgmentInput): Promise<{
  allJudgments: JudgmentResult[];
  runHadFailure: boolean;
}> {
  const {
    outcomes,
    spec,
    testCaseById,
    providers,
    model,
    skillVersion,
    judgeSamples,
    correlation,
    runBudget,
    costSession,
    toolConfig,
  } = input;
  let runHadFailure = false;
  const allJudgments: JudgmentResult[] = [];

  const executionFailed = outcomes.some(isFailedExecution);
  for (const outcome of outcomes) {
    // Preserve an execution failure without spending on a later phase
    // or turning its unknown usage into a budget refusal.
    if (
      costSession?.refused ||
      runBudget.stop ||
      ((runBudget.active || costSession) && executionFailed)
    )
      break;
    if (isFailedExecution(outcome)) continue;
    const testCase = testCaseById.get(outcome.test_case_id);
    // Every outcome originates from a spec test case (runFunctionalTests
    // iterates spec.test_cases), so a miss is an internal invariant
    // break — fail loud rather than silently fall back to ALL criteria.
    if (!testCase) {
      throw new Error(`Outcome references unknown test case id: "${outcome.test_case_id}"`);
    }
    const applicableCriteria = selectCriteriaForTestCase(spec.criteria, testCase.criteria_ids);
    const judgments = await judgeCriteria(applicableCriteria, outcome, providers.judge, {
      ...(toolConfig?.runtime.judgeObservations
        ? {
            observations: getJudgeObservations(
              outcome,
              true,
              toolConfig.runtime.limits.maxTotalBytes,
            ),
          }
        : {}),
      // The JUDGE's model id (differs from the eval target when
      // --judge-provider/--judge-model decouple the judge) — feeds
      // JudgmentResult.judge_model, evidence, and the OTel modelId.
      model: providers.judgeModelId,
      // N-sample majority voting: --samples overrides the spec's
      // default; a criterion's own `samples` overrides both.
      samples: judgeSamples,
      judgeTemperature: spec.judge_temperature,
      // Per-call judge timeout (engine defaults 120s when unset) and
      // the per-criterion sample-dispatch bound for rate-limited
      // judge endpoints.
      judgeTimeoutMs: spec.judge_timeout_ms,
      sampleConcurrency: spec.judge_sample_concurrency,
    });

    // OTel per-criterion events (067 §§ 1.1, 1.2). For judge-method
    // criteria we emit judge.invoked + judge.verdict; for every
    // criterion we emit runtime.criterion.evaluated with the binary
    // outcome mapped to the closed {pass,fail,skip} enum.
    if (emitJudgmentEvidence(judgments, correlation, model, skillVersion)) runHadFailure = true;

    // Stamp each judgment row with its test case: a criterion judged
    // on multiple test cases produces one row per case, and the
    // vote-evidence array is ambiguous without the id.
    allJudgments.push(...judgments.map((j) => ({ ...j, test_case_id: outcome.test_case_id })));
  }
  return { allJudgments, runHadFailure };
}

function emitJudgmentEvidence(
  judgments: JudgmentResult[],
  correlation: EvalCorrelation,
  model: string,
  skillVersion: string,
): boolean {
  let runHadFailure = false;
  for (const j of judgments) {
    if (j.method === "judge") {
      // One invoked+verdict pair PER SAMPLE: with multi-sample
      // majority voting the per-sample verdicts are the auditable
      // trace of the judge noise the majority decision absorbed.
      // Single-call results have no sample_verdicts and emit the
      // legacy single pair.
      for (const sampleVerdict of j.sample_verdicts ?? [j.verdict]) {
        emitJudgeInvoked(correlation, {
          judgeId: `j-rig:judge:${j.criterion_id}`,
          modelId: j.judge_model ?? model,
          modelVersion: skillVersion,
        });
        // A judge with no seed cannot reach RF-2 (066 § 1); j-rig
        // judges run un-seeded today, so verdict_source is
        // llm_no_seed and the seed attribute is null (omitted).
        emitJudgeVerdict(correlation, {
          verdict: sampleVerdict,
          verdictSource: JudgeVerdictSource.LLM_NO_SEED,
          seed: null,
        });
      }
    }
    const criterionOutcome =
      j.verdict === "yes"
        ? CriterionOutcome.PASS
        : j.verdict === "unsure"
          ? CriterionOutcome.SKIP
          : CriterionOutcome.FAIL;
    if (criterionOutcome === CriterionOutcome.FAIL) runHadFailure = true;
    emitRuntimeCriterionEvaluated(correlation, {
      matcherClass: j.method,
      outcome: criterionOutcome,
      // Multi-sample enrichment: agreement is queryable per
      // criterion without folding the N judge.verdict events.
      samples: j.samples,
      agreement: j.agreement,
    });
  }
  return runHadFailure;
}
