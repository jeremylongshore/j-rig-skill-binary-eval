import {
  CriterionOutcome,
  emitRuntimeCriterionEvaluated,
  type EvalCorrelation,
  type JudgmentResult,
  type Criterion,
} from "@j-rig/core";
import { storeCriterionResults, storeRunSummary, type JRigDatabase } from "@j-rig/db";
import type { SkillEvalSpec } from "../lib/loaders.js";
import { formatScore, icon } from "../lib/output.js";

interface JudgmentPersistenceInput {
  allJudgments: JudgmentResult[];
  selfTestJudgment?: JudgmentResult;
  selfTestCriterion?: Criterion;
  correlation: EvalCorrelation;
  opts: { json?: boolean };
  database: JRigDatabase;
  runId: number;
  spec: Pick<SkillEvalSpec, "criteria">;
}

/** Fold the once-per-invocation self-test before printing and persisting this model's tally. */
export function persistModelJudgments(input: JudgmentPersistenceInput) {
  const {
    allJudgments,
    selfTestJudgment,
    selfTestCriterion,
    correlation,
    opts,
    database,
    runId,
    spec,
  } = input;
  let selfTestFailed = false;
  // Fold the (model-independent) self-test verdict into THIS model's
  // judgments BEFORE the tally + persistence, so it counts in the
  // score line, the console output, the stored criterion_results, and
  // the run summary — consistent with the rollout decision it drives.
  if (selfTestJudgment) {
    allJudgments.push(selfTestJudgment);
    const stOutcome =
      selfTestJudgment.verdict === "yes" ? CriterionOutcome.PASS : CriterionOutcome.FAIL;
    if (stOutcome === CriterionOutcome.FAIL) selfTestFailed = true;
    emitRuntimeCriterionEvaluated(correlation, {
      matcherClass: "deterministic",
      outcome: stOutcome,
    });
  }

  const passed = allJudgments.filter((j) => j.verdict === "yes").length;
  const total = allJudgments.length;

  if (!opts.json) {
    console.log(`  Judgment: ${formatScore(passed, total)}`);
    for (const j of allJudgments) {
      const verdictIcon =
        j.verdict === "yes"
          ? icon("pass")
          : j.verdict === "unsure"
            ? icon("warning")
            : icon("error");
      console.log(`    ${verdictIcon} ${j.criterion_id}: ${j.reasoning.slice(0, 80)}`);
    }
  }

  // ── Evidence persistence ───────────────────────────────────
  const dbResults = allJudgments.map((j) => ({
    criterion_id: j.criterion_id,
    passed: j.verdict === "yes",
    severity: j.verdict === "yes" ? "pass" : j.verdict === "unsure" ? "warning" : "error",
    message: j.reasoning,
    method: j.method,
  }));
  storeCriterionResults(database, runId, dbResults);

  const errors = allJudgments.filter((j) => j.verdict === "no").length;
  const warnings = allJudgments.filter((j) => j.verdict === "unsure").length;
  storeRunSummary(database, runId, {
    total,
    passed,
    warnings,
    errors,
  });

  // ── Governance (score, layers 4 regression + 5 baseline, decision) ──
  const scoringCriteria = selfTestCriterion ? [...spec.criteria, selfTestCriterion] : spec.criteria;

  return { scoringCriteria, selfTestFailed };
}
