import { z } from "zod";
import {
  CostPolicySchema,
  costStopMicros,
  priceCostUsage,
  reserveCost,
  safeMicros,
  type CostPolicy,
} from "./cost-policy.js";
import { EvaluationTokenUsageSchema } from "./evaluation-usage.js";

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value);
const micros = z.number().int().nonnegative().safe();
export const CostEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("policy"), policy: CostPolicySchema }).strict(),
  z
    .object({
      kind: z.literal("reserve"),
      callId: id,
      attemptId: id,
      fileId: id,
      phase: id,
      provider: id,
      model: id,
      outputLimit: micros.positive(),
      reservedMicros: micros,
      requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("settle"),
      callId: id,
      outcome: z.enum(["completed", "failed", "interrupted"]),
      reportedModel: id.nullable(),
      usage: EvaluationTokenUsageSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("halt"),
      fileId: id,
      scope: z.enum(["file", "wave"]),
      reason: z.enum([
        "file-limit",
        "wave-stop",
        "file-tokens",
        "wave-tokens",
        "file-attempts",
        "wave-attempts",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("outcome"),
      attemptId: id,
      fileId: id,
      decision: z.enum(["accepted", "rejected", "blocked", "proposed", "scored", "failed"]),
    })
    .strict(),
]);
export type CostEvent = z.infer<typeof CostEventSchema>;
type Reservation = Extract<CostEvent, { kind: "reserve" }>;
type Settlement = Extract<CostEvent, { kind: "settle" }>;
export interface CostRollup {
  knownTokens: number;
  committedTokens: number;
  calls: number;
  knownMicros: number;
  committedMicros: number;
  pendingCalls: number;
  unknownCalls: number;
  accepted: number;
  costPerAcceptMicros: number | null;
  quarantined: boolean;
}
export interface CostLedgerState {
  policy: CostPolicy;
  lastHalt?: Extract<CostEvent, { kind: "halt" }>;
  files: Record<string, CostRollup>;
  total: CostRollup;
  stopped: boolean;
  p0: boolean;
  aboveMeanBudget: boolean;
  calls: Map<string, { reservation: Reservation; settlement?: Settlement }>;
  outcomes: Set<string>;
}
const empty = (): CostRollup => ({
  knownTokens: 0,
  committedTokens: 0,
  calls: 0,
  knownMicros: 0,
  committedMicros: 0,
  pendingCalls: 0,
  unknownCalls: 0,
  accepted: 0,
  costPerAcceptMicros: null,
  quarantined: false,
});
const add = (a: number, b: number): number => safeMicros(BigInt(a) + BigInt(b));
/** Replay is authoritative: prices and commitments are recomputed from the pinned policy. */
export function replayCostLedger(input: readonly unknown[]): CostLedgerState {
  const events = input.map((event) => CostEventSchema.parse(event));
  const first = events[0];
  if (first?.kind !== "policy") throw new Error("Cost ledger lacks initial policy");
  const policy = first.policy;
  const state: CostLedgerState = {
    policy,
    files: Object.fromEntries(policy.files.map((id) => [id, empty()])),
    total: empty(),
    stopped: false,
    p0: false,
    aboveMeanBudget: false,
    calls: new Map(),
    outcomes: new Set(),
  };
  for (const event of events.slice(1)) applyCostEvent(state, event);
  for (const call of state.calls.values()) accumulateCallCost(state, call);
  summarizeCostLedger(state);
  return state;
}

/** Replay event validation in ledger order before computing any rollups. */
function applyCostEvent(state: CostLedgerState, event: CostEvent): void {
  const { policy } = state;
  if (event.kind === "policy") throw new Error("Duplicate cost policy");
  if (event.kind === "reserve") {
    const rate = policy.rates.find((r) => r.provider === event.provider && r.model === event.model);
    if (
      !Object.hasOwn(state.files, event.fileId) ||
      !rate ||
      state.calls.has(event.callId) ||
      state.outcomes.has(event.attemptId) ||
      [...state.calls.values()].some(
        (call) =>
          call.reservation.attemptId === event.attemptId &&
          call.reservation.fileId !== event.fileId,
      ) ||
      event.reservedMicros !== reserveCost(rate, event.outputLimit)
    )
      throw new Error("Invalid cost reservation");
    state.calls.set(event.callId, { reservation: event });
  } else if (event.kind === "settle") {
    const call = state.calls.get(event.callId);
    if (!call || call.settlement) throw new Error("Missing or duplicate cost settlement");
    call.settlement = event;
  } else {
    const file = Object.hasOwn(state.files, event.fileId) ? state.files[event.fileId] : undefined;
    if (!file) throw new Error("Unknown cost file");
    if (event.kind === "halt") {
      state.lastHalt = event;
      if (event.scope === "wave") state.stopped = true;
      else file.quarantined = true;
    } else {
      if (state.outcomes.has(event.attemptId)) throw new Error("Duplicate cost outcome");
      if (
        [...state.calls.values()].some(
          (c) =>
            c.reservation.attemptId === event.attemptId &&
            (c.reservation.fileId !== event.fileId ||
              (!c.settlement && event.decision !== "failed")),
        )
      )
        throw new Error("Unsettled or mismatched cost outcome");
      if (event.decision === "accepted") {
        const calls = [...state.calls.values()].filter(
          (c) => c.reservation.attemptId === event.attemptId,
        );
        if (
          !calls.some((c) => c.settlement?.outcome === "completed") ||
          calls.some((c) => {
            const rate = policy.rates.find(
              (r) => r.provider === c.reservation.provider && r.model === c.reservation.model,
            )!;
            return (
              !c.settlement?.usage ||
              !c.settlement.reportedModel ||
              !rate.reportedModels.includes(c.settlement.reportedModel) ||
              c.settlement.usage.inputTokens > rate.maxInputTokens ||
              c.settlement.usage.outputTokens > c.reservation.outputLimit ||
              priceCostUsage(rate, c.settlement.usage) > c.reservation.reservedMicros
            );
          })
        )
          throw new Error("Acceptance requires complete priced calls");
      }
      state.outcomes.add(event.attemptId);
      if (event.decision === "accepted") file.accepted++;
    }
  }
}

/** Retain reservations for pending or unpriced calls and quarantine overruns. */
function accumulateCallCost(
  state: CostLedgerState,
  { reservation: r, settlement: s }: { reservation: Reservation; settlement?: Settlement },
): void {
  const { policy } = state;
  const file = state.files[r.fileId]!;
  const rate = policy.rates.find((rate) => rate.provider === r.provider && rate.model === r.model)!;
  const priced =
    s?.usage && s.reportedModel && rate.reportedModels.includes(s.reportedModel)
      ? priceCostUsage(rate, s.usage)
      : null;
  const measuredTokens = s?.usage ? add(s.usage.inputTokens, s.usage.outputTokens) : null;
  file.knownTokens = add(file.knownTokens, measuredTokens ?? 0);
  file.committedTokens = add(
    file.committedTokens,
    measuredTokens ?? add(rate.maxInputTokens, r.outputLimit),
  );
  file.calls = add(file.calls, 1);
  file.committedMicros = add(file.committedMicros, priced ?? r.reservedMicros);
  file.knownMicros = add(file.knownMicros, priced ?? 0);
  if (!s) file.pendingCalls++;
  else if (priced === null) {
    file.unknownCalls++;
    file.quarantined = true;
    state.stopped = true;
  }
  if (
    s?.usage &&
    (s.usage.inputTokens > rate.maxInputTokens ||
      s.usage.outputTokens > r.outputLimit ||
      (priced !== null && priced > r.reservedMicros))
  ) {
    state.p0 = true;
    state.stopped = true;
    file.quarantined = true;
  }
}

/** Aggregate file commitments before evaluating whole-wave limits. */
function summarizeCostLedger(state: CostLedgerState): void {
  const { policy } = state;
  for (const file of Object.values(state.files)) {
    file.quarantined ||=
      file.committedMicros >= policy.maxFileMicros ||
      (policy.maxFileTokens !== undefined && file.committedTokens >= policy.maxFileTokens) ||
      (policy.maxFileAttempts !== undefined && file.calls >= policy.maxFileAttempts);
    file.costPerAcceptMicros =
      file.accepted && !file.pendingCalls && !file.unknownCalls
        ? file.knownMicros / file.accepted
        : null;
    for (const key of [
      "committedTokens",
      "knownTokens",
      "calls",
      "committedMicros",
      "knownMicros",
      "pendingCalls",
      "unknownCalls",
      "accepted",
    ] as const)
      state.total[key] = add(state.total[key], file[key]);
  }
  state.total.costPerAcceptMicros =
    state.total.accepted && !state.total.pendingCalls && !state.total.unknownCalls
      ? state.total.knownMicros / state.total.accepted
      : null;
  state.stopped ||=
    state.total.committedMicros >= costStopMicros(policy) ||
    (policy.maxTotalTokens !== undefined && state.total.committedTokens >= policy.maxTotalTokens) ||
    (policy.maxAttempts !== undefined && state.total.calls >= policy.maxAttempts);
  state.p0 ||= state.total.knownMicros >= policy.maxTotalMicros;
  state.aboveMeanBudget =
    BigInt(state.total.knownMicros) >
    BigInt(policy.meanFileBudgetMicros) * BigInt(policy.files.length);
}
