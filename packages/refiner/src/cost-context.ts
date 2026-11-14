import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CostContextSchema,
  hashValue,
  priceCostUsage,
  safeMicros,
  type CostRollup,
  CostPolicySchema,
  type CostContext,
} from "@intentsolutions/refiner-core";
import { CostLedger } from "./cost-ledger.js";
export interface CostOptions {
  costPolicy?: string;
  costLedger?: string;
  costFileId?: string;
}
export interface CostSession {
  context: CostContext;
  ledger: CostLedger;
}
export function openCostSession(input: unknown): CostSession {
  const context = CostContextSchema.parse(input);
  if (!isAbsolute(context.policyPath) || !isAbsolute(context.ledgerPath))
    throw new Error("Cost context paths must be absolute");
  const policy = CostPolicySchema.parse(JSON.parse(readFileSync(context.policyPath, "utf8")));
  if (!policy.files.includes(context.fileId))
    throw new Error("File identity absent from cost policy");
  return { context, ledger: new CostLedger(context.ledgerPath, policy) };
}
export function costSessionFromOptions(opts: CostOptions): CostSession | undefined {
  if (!opts.costPolicy) {
    if (opts.costLedger || opts.costFileId) throw new Error("Cost options require --cost-policy");
    return undefined;
  }
  if (!opts.costFileId) throw new Error("--cost-policy requires --cost-file-id");
  return openCostSession({
    policyPath: resolve(opts.costPolicy),
    ledgerPath: resolve(opts.costLedger ?? "audit/wave-b-cost-ledger.jsonl"),
    fileId: opts.costFileId,
    attemptId: randomUUID(),
  });
}
export interface CostOutcomeReport {
  schema: "refiner-cost-outcome/v1";
  attemptId: string;
  fileId: string;
  policyHash: string;
  scopeId: string;
  decision: "accepted" | "rejected" | "blocked" | "proposed" | "scored" | "failed";
  inputTokens: number;
  outputTokens: number;
  calls: number;
  unknownCalls: number;
  knownMicros: number;
  file: CostRollup;
  total: CostRollup;
  stopped: boolean;
  p0: boolean;
  cohortSize: number;
  meanKnownMicros: number;
  meanComplete: boolean;
  aboveMeanBudget: boolean;
}
export function recordCostOutcome(
  session: CostSession | undefined,
  decision: "accepted" | "rejected" | "blocked" | "proposed" | "scored" | "failed",
): CostOutcomeReport | undefined {
  if (!session || session.ledger.snapshot().outcomes.has(session.context.attemptId)) return;
  const state = session.ledger.outcome({
    attemptId: session.context.attemptId,
    fileId: session.context.fileId,
    decision,
  });
  const calls = [...state.calls.values()].filter(
    (c) => c.reservation.attemptId === session.context.attemptId,
  );
  let input = 0n,
    output = 0n,
    known = 0n,
    unknown = 0;
  for (const call of calls) {
    const usage = call.settlement?.usage;
    if (usage) {
      input += BigInt(usage.inputTokens);
      output += BigInt(usage.outputTokens);
    }
    const rate = state.policy.rates.find(
      (r) => r.provider === call.reservation.provider && r.model === call.reservation.model,
    )!;
    if (
      usage &&
      call.settlement?.reportedModel &&
      rate.reportedModels.includes(call.settlement.reportedModel)
    )
      known += BigInt(priceCostUsage(rate, usage));
    else unknown++;
  }
  return {
    schema: "refiner-cost-outcome/v1",
    attemptId: session.context.attemptId,
    fileId: session.context.fileId,
    policyHash: hashValue(state.policy),
    scopeId: state.policy.scopeId,
    decision,
    inputTokens: safeMicros(input),
    outputTokens: safeMicros(output),
    calls: calls.length,
    unknownCalls: unknown,
    knownMicros: safeMicros(known),
    file: state.files[session.context.fileId]!,
    total: state.total,
    stopped: state.stopped,
    p0: state.p0,
    cohortSize: state.policy.files.length,
    meanKnownMicros: state.total.knownMicros / state.policy.files.length,
    meanComplete: state.total.unknownCalls === 0 && state.total.pendingCalls === 0,
    aboveMeanBudget: state.aboveMeanBudget,
  };
}
