import {
  CostPhaseName,
  emitCostPhaseRecorded,
  emitCostRunRecorded,
  type EvalCorrelation,
} from "@j-rig/core";
import type { EvalCostReport } from "../providers/cost-tracking.js";

/** Report the settled meter snapshot without changing result or gate payloads. */
export function reportEvalCost(
  costReport: EvalCostReport | null,
  opts: { json?: boolean },
  correlation: EvalCorrelation,
  judgeSamples: number | undefined,
): void {
  if (!opts.json && costReport) {
    const { total, phases } = costReport;
    console.log(
      `  Eval cost: ${total.input_tokens} in / ${total.output_tokens} out tokens, ` +
        `${total.calls} calls (${costReport.unknown_calls} unmeasured; tokens are known subtotals) ` +
        `(trigger ${phases.trigger.calls}, execution ${phases.execution.calls}, ` +
        `judge ${phases.judge.calls})`,
    );
    const perModel = costReport.by_model
      .map((m) => `${m.model}: ${m.usd === null ? "no rate on file" : `$${m.usd.toFixed(4)}`}`)
      .join("; ");
    const notBilled =
      costReport.estimated_usd !== null &&
      costReport.billed_usd !== null &&
      costReport.billed_usd < costReport.estimated_usd
        ? ` (billed $${costReport.billed_usd.toFixed(4)}; the rest is API-equivalent ` +
          `claude-code subscription usage, not billed)`
        : "";
    console.log(
      `    estimated: ${
        costReport.estimated_usd === null
          ? "n/a (a model has no rate on file)"
          : `$${costReport.estimated_usd.toFixed(4)}`
      }${notBilled} — ${perModel}`,
    );
  }

  // OTel cost.* run-end summary (observability review BUILD-NOW #1).
  // Cost never rides the pinned judge.*/gate.* payloads.
  if (costReport) {
    for (const phase of Object.values(CostPhaseName)) {
      const p = costReport.phases[phase];
      emitCostPhaseRecorded(correlation, {
        phase,
        inputTokens: p.input_tokens,
        outputTokens: p.output_tokens,
        calls: p.calls,
        unknownCalls: costReport.usage_evidence.calls.filter(
          (call) => call.phase === phase && call.usage === null,
        ).length,
        ...(phase === CostPhaseName.JUDGE ? { judgeSamples: judgeSamples ?? 1 } : {}),
      });
    }
    emitCostRunRecorded(correlation, {
      totalInputTokens: costReport.total.input_tokens,
      totalOutputTokens: costReport.total.output_tokens,
      totalCalls: costReport.total.calls,
      estimatedUsd: costReport.estimated_usd,
      usageComplete: costReport.usage_complete,
      unknownCalls: costReport.unknown_calls,
    });
  }
}
