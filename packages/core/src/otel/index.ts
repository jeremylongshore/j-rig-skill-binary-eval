/**
 * OTel instrumentation surface for the j-rig behavioral-eval emitter (iaj-E08).
 *
 * Public exports:
 *   - Name + attribute + enum constants (the in-repo pin of the 067 taxonomy +
 *     kernel YAML).
 *   - The best-effort emitter primitives (`emitOtelEvent`, `withEvalSpan`).
 *   - Typed per-event helpers (`emitRuntimeRunStarted`, `emitJudgeVerdict`, …).
 *
 * See `./names.ts` for the authority chain (067-AT-SPEC + kernel YAML) and
 * `./emitter.ts` for the best-effort-no-op design.
 */

export {
  OtelEvents,
  OtelAttrs,
  RuntimeTerminalState,
  CriterionOutcome,
  JudgeVerdictSource,
  GateDecision,
  CostPhaseName,
  type OtelEventName,
  type OtelAttrKey,
  type RuntimeTerminalStateValue,
  type CriterionOutcomeValue,
  type JudgeVerdictSourceValue,
  type GateDecisionValue,
  type CostPhaseNameValue,
} from "./names.js";

export {
  emitOtelEvent,
  withEvalSpan,
  type OtelAttrValue,
  type OtelEventPayload,
} from "./emitter.js";

export {
  emitRuntimeRunStarted,
  emitRuntimeRunFinished,
  emitRuntimeCriterionEvaluated,
  emitJudgeInvoked,
  emitJudgeVerdict,
  emitGateDecisionEmitted,
  emitCostRunRecorded,
  emitCostPhaseRecorded,
  type EvalCorrelation,
} from "./events.js";

export { uuidv7 } from "./uuid.js";
