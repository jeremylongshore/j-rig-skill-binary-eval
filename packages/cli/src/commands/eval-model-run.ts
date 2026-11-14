import {
  buildRoster,
  runTriggerTests,
  computeMetrics,
  emitRuntimeRunFinished,
  RuntimeTerminalState,
  GateDecision,
  type TriggerResult,
  type BaselineComparison,
  type ObservedOutcome,
  type JudgmentResult,
} from "@j-rig/core";
import { transitionRun } from "@j-rig/db";
import { header, icon } from "../lib/output.js";
import type { EvalCostReport } from "../providers/cost-tracking.js";
import type { BudgetStop } from "../providers/budget.js";
import { startEvaluationModel, type EvaluationInvocation } from "./eval-runtime-context.js";
import { storeTriggerEvidence } from "./trigger-evidence.js";
import { detectInfrastructureFailure } from "./eval-infrastructure-failure.js";
import { resolvePhaseBudgetStop } from "./eval-budget-phase.js";
import { observeFunctionalPhase } from "./eval-observation-phase.js";
import { evaluateOutcomeJudgments } from "./eval-judgments.js";
import { persistModelJudgments } from "./eval-judgment-persistence.js";
import { evaluateNakedBaseline } from "./eval-baseline-phase.js";
import { evaluateModelGovernance, sanitizeSegment } from "./eval-governance-phase.js";
import { describeEvaluatedModel } from "./eval-model-result.js";
import { recordEvaluatedModelCompletion } from "./eval-model-completion.js";
import { reportEvalCost } from "./eval-cost-report.js";

type ModelEvaluationResult =
  { status: "budget-stopped" } | { status: "completed"; infrastructureFailureSeen: boolean };

/** Run one model in order; the invocation alone decides whether another model starts. */
export async function evaluateSingleModel(
  context: EvaluationInvocation,
  model: string,
): Promise<ModelEvaluationResult> {
  const {
    opts,
    executionParameters,
    executionMetadata,
    claudeCodeSettings,
    toolConfig,
    skill,
    spec,
    judgeSamples,
    database,
    skillName,
    skillVersion,
    skillSnapshotSha,
    specContentHash,
    pkgReport,
    allResults,
    retainedRollouts,
    bundleRows,
    bundleRunIds,
    jrigVersion,
    commit,
    batchLineage,
    selfTestJudgment,
    selfTestCriterion,
    runBudget,
    costSession,
  } = context;
  let infrastructureFailureSeen = false;
  const { modelStart, runId, costMeter, providers, correlation } = startEvaluationModel(
    context,
    model,
  );
  // Did any criterion or gate decision fail? Drives the terminal-state
  // enum on runtime.run.finished.
  let runHadFailure = false;

  // ── Budget stop (providers/budget.ts) ──────────────────────────
  // Called at a phase boundary once the guard has refused a call. The
  // evaluation is incomplete, so there is NO verdict and NO Evidence
  // Bundle row (an `error` row means a provider failed, which this is
  // not); the run is stored `failed` with the stop as its reason, and
  // the remaining models are not started.
  const stopForBudget = (stop: BudgetStop): void => {
    transitionRun(database, runId, "failed", JSON.stringify({ type: "budget_exhausted", ...stop }));
    allResults[model] = {
      ...executionMetadata,
      provider: providers.providerName,
      model,
      judge_provider: providers.judgeProviderName,
      judge_model: providers.judgeModelId,
      ground_truth: providers.real,
      pkgReport,
      budget_stop: stop,
      cost: providers.real || claudeCodeSettings ? costMeter.report() : null,
      ...batchLineage,
    };
    if (!opts.json) {
      console.log(
        `  ${icon("error")} Budget exhausted in the ${stop.phase} phase: ${stop.reason}. ` +
          `Stopped with no verdict.`,
      );
    }
    emitRuntimeRunFinished(correlation, {
      terminalState: RuntimeTerminalState.ARCHIVED_FAILED,
      durationMs: Date.now() - modelStart,
    });
  };

  if (!opts.json) {
    console.log(header(`--- Model: ${model} ---`));
    console.log(
      `  Provider: ${
        providers.real
          ? `${providers.providerName} (REAL — ground truth)`
          : `${providers.providerName.toUpperCase()} (not ground truth)`
      }`,
    );
    if (providers.judgeProviderName !== providers.providerName) {
      console.log(
        `  Judge: ${providers.judgeProviderName} (${providers.judgeModelId}) — decoupled via --judge-provider`,
      );
    }
  }

  // ── Trigger tests ──────────────────────────────────────────────
  costMeter.phase = "trigger";
  let triggerResults: TriggerResult[] = [];
  if (opts.trigger !== false) {
    const roster = buildRoster(skill.frontmatter, spec.siblings);
    triggerResults = await runTriggerTests(spec.test_cases, roster, providers.trigger);
    const metrics = computeMetrics(triggerResults);

    if (!opts.json) {
      console.log(
        `  Trigger: precision=${metrics.precision.toFixed(2)} recall=${metrics.recall.toFixed(2)} (${metrics.total_cases} cases)`,
      );
    }
  }

  const triggerEvidence = storeTriggerEvidence(
    database,
    opts.db,
    runId,
    opts.trigger !== false,
    triggerResults,
  );
  const triggerFailure = detectInfrastructureFailure({
    triggers: triggerResults,
    outcomes: [],
    judgments: [],
    executionProvider: providers.providerName,
    judgeProvider: providers.judgeProviderName,
  });
  // A refused call keeps the budget-stop path. A provider failure with
  // unknown usage must still reach the signed infrastructure-error path.
  const triggerBudgetStop = resolvePhaseBudgetStop({
    costSession,
    runBudget,
    failure: triggerFailure,
    model,
    modelStart,
  });
  if (triggerBudgetStop) {
    stopForBudget(triggerBudgetStop);
    return { status: "budget-stopped" as const };
  }

  // Finalized after whichever phases run. This intentionally lives
  // outside the functional branch: trigger-only real-provider runs
  // spend tokens too and must emit the same cost.* run-end record.
  let costReport: EvalCostReport | null = null;

  // ── Functional tests + judgment ────────────────────────────────
  if (opts.functional !== false) {
    const { outcomes, toolReceipts } = await observeFunctionalPhase({
      costMeter,
      admissionActive: Boolean(runBudget.active || costSession),
      triggerFailure,
      spec,
      skill,
      providers,
      model,
      toolConfig,
      database,
      opts,
      runId,
      executionParameters,
    });

    // Judge each outcome against the criteria that test case actually
    // exercises and flatten results. A test case may scope itself via
    // `criteria_ids` (schema default: ALL); honoring it stops an
    // off-topic criterion being judged against an unrelated control
    // prompt — the false-blocker bug that inflated NO-SHIP rates.
    const testCaseById = new Map(spec.test_cases.map((tc) => [tc.id, tc]));
    costMeter.phase = "judge";
    const { allJudgments, runHadFailure: judgmentFailed } = await evaluateOutcomeJudgments({
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
    });
    if (judgmentFailed) runHadFailure = true;

    const skillFailure = detectInfrastructureFailure({
      triggers: triggerResults,
      outcomes,
      judgments: allJudgments,
      executionProvider: providers.providerName,
      judgeProvider: providers.judgeProviderName,
    });
    const skillBudgetStop = resolvePhaseBudgetStop({
      costSession,
      runBudget,
      failure: skillFailure,
      model,
      modelStart,
    });
    if (skillBudgetStop) {
      stopForBudget(skillBudgetStop);
      return { status: "budget-stopped" as const };
    }

    const { scoringCriteria, selfTestFailed } = persistModelJudgments({
      allJudgments,
      selfTestJudgment,
      selfTestCriterion,
      correlation,
      opts,
      database,
      runId,
      spec,
    });
    if (selfTestFailed) runHadFailure = true;

    // Layer 5 — Baseline value (opt-in --baseline-check): re-run the same
    // test cases against the NAKED model (empty skill body = no skill
    // context) and compare. A skill that adds no value over the base model
    // is flagged obsolete_review. Doubles execution+judge cost (metered),
    // so it is opt-in; when off, the baseline layer is reported skipped.
    let baselineComparisons: BaselineComparison[] = [];
    let isObsolete = false;
    let ranBaseline = false;
    // Hoisted so a provider failure in the naked-baseline pass is held
    // to the same infrastructure-failure rule as the skill pass.
    let baselineOutcomes: ObservedOutcome[] = [];
    let baselineJudgments: JudgmentResult[] = [];
    if (opts.baselineCheck && (!(runBudget.active || costSession) || !skillFailure)) {
      ranBaseline = true;
      ({ baselineOutcomes, baselineJudgments, baselineComparisons, isObsolete } =
        await evaluateNakedBaseline({
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
          dbPath: opts.db,
          json: opts.json,
        }));
    }
    // The naked-baseline pass spends too; a stop there leaves the
    // skill pass's criterion results stored but the run unverdicted.
    const evaluationFailure = detectInfrastructureFailure({
      triggers: triggerResults,
      outcomes: [...outcomes, ...baselineOutcomes],
      judgments: [...allJudgments, ...baselineJudgments],
      executionProvider: providers.providerName,
      judgeProvider: providers.judgeProviderName,
    });
    const evaluationBudgetStop = resolvePhaseBudgetStop({
      costSession,
      runBudget,
      failure: evaluationFailure,
      model,
      modelStart,
    });
    if (evaluationBudgetStop) {
      stopForBudget(evaluationBudgetStop);
      return { status: "budget-stopped" as const };
    }

    const { ranRegression, scoreCard, decision, report, promotionEvidence } =
      evaluateModelGovernance({
        opts,
        allJudgments,
        scoringCriteria,
        spec,
        isObsolete,
        skillName,
        baselineComparisons,
        modelStart,
        executionMetadata,
        toolConfig,
        providers,
        judgeSamples,
        correlation,
        runId,
        skillVersion,
        skillSnapshotSha,
        specContentHash,
        jrigVersion,
        ranBaseline,
      });
    // ── Eval cost (Jeremy's ask: "what does it cost to eval this
    // skill, as-is?") — real token usage per phase, × N judge samples,
    // with a best-effort USD estimate. Stub runs record nothing.
    costReport = providers.real || claudeCodeSettings ? costMeter.report() : null;

    const infraFailure = evaluationFailure;
    const { result, infraFailureReason, headroom, gateDecisionValue } = describeEvaluatedModel({
      infraFailure,
      scoreCard,
      spec,
      report,
      opts,
      executionMetadata,
      providers,
      model,
      pkgReport,
      subscriptionExecution: Boolean(claudeCodeSettings),
      outcomes,
      allJudgments,
      decision,
      promotionEvidence,
      costReport,
      batchLineage,
      triggerEvidence,
    });
    allResults[model] = result;
    if (gateDecisionValue === GateDecision.FAIL || gateDecisionValue === GateDecision.ERROR) {
      runHadFailure = true;
    }
    if (infraFailure) infrastructureFailureSeen = true;
    recordEvaluatedModelCompletion({
      gateId: `j-rig:local:${sanitizeSegment(skillName, "skill")}.${sanitizeSegment(model, "model")}`,
      infraFailure,
      infraFailureReason,
      promotionEvidence,
      report,
      triggerEvidence,
      allJudgments,
      scoringCriteria,
      spec,
      judgeSamples,
      scoreCard,
      ranRegression,
      ranBaseline,
      specContentHash,
      skillSnapshotSha,
      modelStart,
      jrigVersion,
      commit,
      executionMetadata,
      model,
      providers,
      toolConfig,
      toolReceipts,
      headroom,
      batchLineage,
      opts,
      correlation,
      gateDecisionValue,
      database,
      runId,
      bundleRows,
      bundleRunIds,
      retainedRollouts,
      outcomes,
      subscriptionExecution: Boolean(claudeCodeSettings),
    });
  } else {
    if (triggerFailure) {
      infrastructureFailureSeen = true;
      runHadFailure = true;
      transitionRun(database, runId, "failed", JSON.stringify(triggerFailure));
    } else {
      transitionRun(database, runId, "completed");
    }
  }

  // ── Eval cost (all executed phase combinations) ───────────────
  // A --no-functional run used to skip this whole block because cost
  // reporting lived inside the functional branch. Snapshot the meter
  // here after trigger/execution/judge work has settled, then print and
  // emit one consistent run-end record for both full and trigger-only
  // real-provider evals. Stub runs remain honestly unmetered.
  // claude-code execution is a real run even when the judge is a stub.
  costReport ??= providers.real || claudeCodeSettings ? costMeter.report() : null;
  reportEvalCost(costReport, opts, correlation, judgeSamples);

  // Full runs populate the richer result in the functional branch.
  // Trigger-only runs still need a machine-readable cost/provenance row.
  if (!(model in allResults)) {
    allResults[model] = {
      provider: providers.providerName,
      model,
      judge_provider: providers.judgeProviderName,
      judge_model: providers.judgeModelId,
      ground_truth: providers.real,
      pkgReport,
      functional_skipped: true,
      trigger: triggerEvidence,
      ...(triggerFailure ? { gate_decision: "error", evaluation_error: triggerFailure } : {}),
      cost: costReport,
      ...batchLineage,
    };
  }

  // OTel runtime.run.finished (067 § 1.1). Terminal state per the
  // EvalRun state machine: a run that produced a failing criterion or a
  // FAIL gate decision is archived_failed; an all-pass run is judged.
  // (archived_success is reserved for the runtime's post-judgment
  // archival lifecycle, which the CLI path does not drive.)
  emitRuntimeRunFinished(correlation, {
    terminalState: runHadFailure
      ? RuntimeTerminalState.ARCHIVED_FAILED
      : RuntimeTerminalState.JUDGED,
    durationMs: Date.now() - modelStart,
  });
  return { status: "completed", infrastructureFailureSeen };
}
