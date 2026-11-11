import {
  emitGateDecisionEmitted,
  type EvalCorrelation,
  type GateDecisionValue,
  type LaunchReport,
  type ObservedOutcome,
  type EvidenceStatement,
} from "@j-rig/core";
import { transitionRun, type JRigDatabase } from "@j-rig/db";
import { buildEvaluationStatement, type EvaluationStatementInput } from "./eval-statement.js";
import { retainRolloutRun, type RetainedRolloutRun } from "./rollout-export.js";
import { CLAUDE_CODE_PROVIDER_NAME } from "../providers/claude-code.js";
import { formatDecision, icon } from "../lib/output.js";

export interface EvaluatedModelCompletionInput extends EvaluationStatementInput {
  opts: { json?: boolean; emitBundle?: string; rolloutFile?: string };
  correlation: EvalCorrelation;
  gateDecisionValue: GateDecisionValue;
  report: LaunchReport;
  database: JRigDatabase;
  runId: number;
  bundleRows: EvidenceStatement[];
  bundleRunIds: number[];
  retainedRollouts: RetainedRolloutRun[];
  outcomes: readonly ObservedOutcome[];
  subscriptionExecution: boolean;
}

/** Complete one evaluated model in the existing event, evidence, output and storage order. */
export function recordEvaluatedModelCompletion(input: EvaluatedModelCompletionInput): void {
  const {
    opts,
    infraFailureReason,
    correlation,
    gateDecisionValue,
    specContentHash,
    bundleRows,
    bundleRunIds,
    runId,
    report,
    retainedRollouts,
    model,
    subscriptionExecution,
    providers,
    infraFailure,
    outcomes,
    database,
  } = input;
  if (infraFailureReason && !opts.json) {
    console.log(`  ${icon("error")} ${infraFailureReason}`);
  }
  emitGateDecisionEmitted(correlation, {
    gateName: "j-rig-rollout-gate",
    decision: gateDecisionValue,
    policyRef: specContentHash,
  });

  // ── Evidence Bundle row (opt-in via --emit-bundle) ─────────
  // Compose a real, kernel-validated gate-result/v1 in-toto Statement
  // from this model's rollout decision. composeStatement fail-closes
  // (throws) on any invalid field, so a successfully written bundle is
  // proof-by-construction that every row is kernel-valid and directly
  // consumable by intent-rollout-gate. Reuses the same
  // promotion evidence → pass|fail|advisory mapping as the OTel emit.
  if (opts.emitBundle) {
    const statement = buildEvaluationStatement(input);
    bundleRows.push(statement);
    bundleRunIds.push(runId);
  }

  if (!opts.json) {
    console.log(`  Decision: ${formatDecision(report.decision)}`);
    if (report.blockers.length > 0) {
      for (const b of report.blockers) {
        console.log(`    ${icon("error")} ${b}`);
      }
    }
    if (report.warnings.length > 0) {
      for (const w of report.warnings) {
        console.log(`    ${icon("warning")} ${w}`);
      }
    }
    console.log("");
  }

  if (opts.rolloutFile) {
    retainedRollouts.push(
      retainRolloutRun(
        {
          runId,
          model,
          provider: subscriptionExecution ? CLAUDE_CODE_PROVIDER_NAME : providers.providerName,
          groundTruth: providers.real,
          status: infraFailure ? "failed" : "completed",
        },
        outcomes,
      ),
    );
  }

  if (infraFailure) {
    transitionRun(database, runId, "failed", JSON.stringify(infraFailure));
  } else {
    transitionRun(database, runId, "completed");
  }
}
