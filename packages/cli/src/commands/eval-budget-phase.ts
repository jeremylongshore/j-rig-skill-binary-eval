import { costStopMicros } from "@intentsolutions/refiner-core";
import type { CostSession } from "@intentsolutions/refiner";
import type { RunBudget, BudgetStop } from "../providers/budget.js";
import type { EvalInfrastructureFailure } from "./eval-infrastructure-failure.js";

interface PhaseBudgetInput {
  costSession?: CostSession & {
    providerFailed?: boolean;
    refused?: { phase: "trigger" | "execution" | "judge" };
  };
  runBudget: RunBudget;
  failure: EvalInfrastructureFailure | null;
  model: string;
  modelStart: number;
}

/** Preserve the shared-policy ledger's original stop attribution and units. */
function sharedCostStop({ costSession, model, modelStart }: PhaseBudgetInput): BudgetStop | null {
  if (!costSession?.refused) return null;
  const state = costSession.ledger.snapshot();
  const halt =
    state.lastHalt?.fileId === costSession.context.fileId &&
    (state.lastHalt.scope === "wave" || !state.stopped)
      ? state.lastHalt
      : undefined;
  const wave = halt ? halt.scope === "wave" : state.stopped;
  const spent = wave ? state.total : state.files[costSession.context.fileId]!;
  const tokens = halt?.reason.endsWith("tokens");
  const attempts = halt?.reason.endsWith("attempts");
  const max = tokens
    ? (wave ? state.policy.maxTotalTokens : state.policy.maxFileTokens)!
    : attempts
      ? (wave ? state.policy.maxAttempts : state.policy.maxFileAttempts)!
      : (wave ? costStopMicros(state.policy) : state.policy.maxFileMicros) / 1_000_000;
  return {
    limit: tokens ? "max_tokens" : attempts ? "max_calls" : "max_usd",
    max,
    observed: tokens
      ? spent.committedTokens
      : attempts
        ? spent.calls
        : spent.unknownCalls
          ? null
          : spent.committedMicros / 1_000_000,
    source: "cost-policy",
    phase: costSession.refused.phase,
    model,
    elapsed_ms: Date.now() - modelStart,
    reason: "Shared cost admission refused; inspect the pinned ledger",
  };
}

/** Provider failures retain evidence; only actual admission stops abort later phases/models. */
export function resolvePhaseBudgetStop(input: PhaseBudgetInput): BudgetStop | null {
  const { costSession, runBudget, failure } = input;
  if (
    !costSession?.providerFailed &&
    (costSession?.refused || runBudget.stop || (!failure && runBudget.check()))
  ) {
    return sharedCostStop(input) ?? runBudget.stop!;
  }
  return null;
}
