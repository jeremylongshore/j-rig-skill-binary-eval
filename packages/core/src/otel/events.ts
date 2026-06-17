/**
 * Typed event-emission helpers — one per j-rig-emitted event in the 067
 * taxonomy. Each helper builds the spec-mandated payload (067 §§ 1.1, 1.2, 2.2)
 * with the shared correlation metadata (067 § 4.2) and hands it to the
 * best-effort emitter. Call sites pass domain values; the spec spelling lives
 * here and in `./names.ts` only.
 *
 * Every helper is best-effort and never throws (the emitter swallows failures).
 */

import { emitOtelEvent } from "./emitter.js";
import {
  OtelEvents,
  OtelAttrs,
  type CriterionOutcomeValue,
  type RuntimeTerminalStateValue,
  type JudgeVerdictSourceValue,
  type GateDecisionValue,
} from "./names.js";

/** Shared correlation metadata carried by every event (067 § 4.2). */
export interface EvalCorrelation {
  /** UUIDv7 of the owning EvalRun — required (067 § 4.2). */
  evalRunId: string;
  /** UUIDv7 of the SessionTrace span — recommended. */
  sessionTraceId?: string;
  /** W3C trace-id propagated from ingress — recommended. */
  traceId?: string;
}

function correlationAttrs(c: EvalCorrelation): Record<string, string | undefined> {
  return {
    [OtelAttrs.EVAL_RUN_ID]: c.evalRunId,
    [OtelAttrs.EVAL_SESSION_TRACE_ID]: c.sessionTraceId,
    [OtelAttrs.TRACE_ID]: c.traceId,
  };
}

/**
 * `runtime.run.started` (067 § 1.1) — a worker leases an EvalRun and
 * transitions it to `running`.
 */
export function emitRuntimeRunStarted(
  c: EvalCorrelation,
  payload: { specContentHash: string; skillSnapshotSha: string },
): void {
  emitOtelEvent(OtelEvents.RUNTIME_RUN_STARTED, {
    ...correlationAttrs(c),
    [OtelAttrs.RUNTIME_RUN_SPEC_CONTENT_HASH]: payload.specContentHash,
    [OtelAttrs.RUNTIME_RUN_SKILL_SNAPSHOT_SHA]: payload.skillSnapshotSha,
  });
}

/**
 * `runtime.run.finished` (067 § 1.1) — the EvalRun reaches a terminal state.
 */
export function emitRuntimeRunFinished(
  c: EvalCorrelation,
  payload: { terminalState: RuntimeTerminalStateValue; durationMs: number },
): void {
  emitOtelEvent(OtelEvents.RUNTIME_RUN_FINISHED, {
    ...correlationAttrs(c),
    [OtelAttrs.RUNTIME_RUN_TERMINAL_STATE]: payload.terminalState,
    [OtelAttrs.RUNTIME_RUN_DURATION_MS]: payload.durationMs,
  });
}

/**
 * `runtime.criterion.evaluated` (067 § 1.1) — one matcher/criterion is scored
 * within a SessionTrace.
 */
export function emitRuntimeCriterionEvaluated(
  c: EvalCorrelation,
  payload: { matcherClass: string; outcome: CriterionOutcomeValue },
): void {
  emitOtelEvent(OtelEvents.RUNTIME_CRITERION_EVALUATED, {
    ...correlationAttrs(c),
    [OtelAttrs.RUNTIME_CRITERION_MATCHER_CLASS]: payload.matcherClass,
    [OtelAttrs.RUNTIME_CRITERION_OUTCOME]: payload.outcome,
  });
}

/**
 * `judge.invoked` (067 § 1.2) — an LLM judge is dialed for a matching event.
 */
export function emitJudgeInvoked(
  c: EvalCorrelation,
  payload: { judgeId: string; modelId: string; modelVersion: string },
): void {
  emitOtelEvent(OtelEvents.JUDGE_INVOKED, {
    ...correlationAttrs(c),
    [OtelAttrs.JUDGE_ID]: payload.judgeId,
    [OtelAttrs.JUDGE_MODEL_ID]: payload.modelId,
    [OtelAttrs.JUDGE_MODEL_VERSION]: payload.modelVersion,
  });
}

/**
 * `judge.verdict` (067 § 1.2) — a JudgeDecision is finalized. `judge.seed` is
 * `int | null`; pass `null` for non-seeded (e.g. deterministic / llm_no_seed)
 * verdicts and the emitter omits the attribute.
 */
export function emitJudgeVerdict(
  c: EvalCorrelation,
  payload: {
    verdict: string;
    verdictSource: JudgeVerdictSourceValue;
    seed: number | null;
  },
): void {
  emitOtelEvent(OtelEvents.JUDGE_VERDICT, {
    ...correlationAttrs(c),
    [OtelAttrs.JUDGE_VERDICT]: payload.verdict,
    [OtelAttrs.JUDGE_VERDICT_SOURCE]: payload.verdictSource,
    [OtelAttrs.JUDGE_SEED]: payload.seed,
  });
}

/**
 * `gate.decision.emitted` (067 § 2.2) — a RolloutGate decision row is emitted
 * under `gate-result/v1`. Spelling identical to the audit-harness iah-E07
 * emitter (the second independent emitter this name is pinned to keep aligned).
 */
export function emitGateDecisionEmitted(
  c: EvalCorrelation,
  payload: { gateName: string; decision: GateDecisionValue; policyRef: string },
): void {
  emitOtelEvent(OtelEvents.GATE_DECISION_EMITTED, {
    ...correlationAttrs(c),
    [OtelAttrs.GATE_NAME]: payload.gateName,
    [OtelAttrs.GATE_DECISION]: payload.decision,
    [OtelAttrs.GATE_POLICY_REF]: payload.policyRef,
  });
}
