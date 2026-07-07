/**
 * Canonical OTel event-name + attribute-key constants for the j-rig
 * behavioral-eval emitter (iaj-E08).
 *
 * AUTHORITY. These names are NOT invented here. They are reproduced verbatim
 * from the two normative sources the cross-emitter pin (Gregg finding #2)
 * names as authoritative:
 *
 *   1. The runtime event taxonomy
 *      `intent-eval-lab/000-docs/067-AT-SPEC-runtime-event-taxonomy-2026-06-12.md`
 *      (NORMATIVE, authority Blueprint B § 4.3 + § 7.2). § 1.1 mints the
 *      `runtime.*` event names, § 1.2 the `judge.*` names, § 2.2 the `gate.*`
 *      names — every name j-rig emits. That doc explicitly binds iaj-E08 (this
 *      emitter): "the j-rig behavioral-eval emitter that MUST emit the
 *      `judge.*` and `replay.*` names; the second independent emitter the
 *      cross-emitter pin guards against drift between" (§ 5 cross-references).
 *
 *   2. The kernel YAML `intent-eval-core/schemas/v1/otel-attributes.yaml`
 *      (the naming AUTHORITY for the four already-pinned events + the shared
 *      correlation attributes `eval.run_id`, `eval.session_trace_id`,
 *      `trace.id`). 067 § 4.1: "On any disagreement the kernel YAML wins."
 *
 * Spelling is OTel-idiomatic dotted-lowercase with snake_case leaf segments,
 * identical to the kernel YAML's convention (067 § 4.1). The kernel package
 * `@intentsolutions/core@0.5.0` does NOT yet export TypeScript constants at
 * `@intentsolutions/core/otel/v1` (067 § 4.1 names that as the future
 * promotion path — "promote the attribute names into the kernel YAML and
 * export the TypeScript constants at @intentsolutions/core/otel/v1"). Until
 * that export exists, these constants are the in-repo pin so j-rig emits one
 * canonical form per name. When the kernel exports its constants, this file
 * becomes a re-export shim and the drift-guard test
 * (`otel.names.test.ts`) is updated to assert equality with the kernel export.
 *
 * Audit-harness (iah-E07) is the OTHER independent emitter; its
 * `scripts/emit-evidence.sh` spells `gate.decision.emitted` / `gate.name` /
 * `gate.decision` / `gate.policy_ref` identically — the two emitters MUST NOT
 * diverge (067 § 5, the exact hazard this file exists to prevent).
 */

/**
 * Event names. Closed set — every j-rig emission MUST use one of these. Names
 * are reserved the moment they appear in a NORMATIVE section of 067 (§ 4.1
 * naming standard); minting an ad-hoc synonym is an anti-pattern refused on
 * sight (067 § 5).
 */
export const OtelEvents = {
  // EXECUTION events (067 § 1.1, category `runtime.*`).
  /** A worker leases an EvalRun and transitions it to `running`. */
  RUNTIME_RUN_STARTED: "runtime.run.started",
  /** The EvalRun reaches a terminal state. */
  RUNTIME_RUN_FINISHED: "runtime.run.finished",
  /** One matcher/criterion is scored within a SessionTrace. */
  RUNTIME_CRITERION_EVALUATED: "runtime.criterion.evaluated",

  // JUDGE events (067 § 1.2, category `judge.*`).
  /** An LLM judge is dialed for a matching event. */
  JUDGE_INVOKED: "judge.invoked",
  /** A JudgeDecision is finalized for a matching event. */
  JUDGE_VERDICT: "judge.verdict",

  // GOVERNANCE events (067 § 2.2, category `gate.*`).
  /**
   * A RolloutGate decision row is emitted under `gate-result/v1`. The NORMATIVE
   * end-of-evaluation event a ship-gate dashboard alerts on. Identical spelling
   * to the audit-harness iah-E07 emitter.
   */
  GATE_DECISION_EMITTED: "gate.decision.emitted",

  // COST events (observability review BUILD-NOW #1). `cost.*` is the
  // reserved-but-unnamed 067 category minted HERE — this file is the naming
  // authority until the taxonomy doc gains its cost.* section (a separate docs
  // follow-up in intent-eval-lab). Run-end summary events only: cost NEVER
  // rides the pinned judge.*/gate.* payloads.
  /** Run-end cost summary — one per per-model eval run with a real provider. */
  COST_RUN_RECORDED: "cost.run.recorded",
  /** Per-phase cost breakdown — one per eval phase (trigger/execution/judge). */
  COST_PHASE_RECORDED: "cost.phase.recorded",
} as const;

export type OtelEventName = (typeof OtelEvents)[keyof typeof OtelEvents];

/**
 * Attribute keys. The shared correlation keys are OWNED by the kernel YAML
 * (reproduced verbatim); the per-event keys are minted by 067 in the section
 * cited beside each. Spelling is load-bearing — see file header.
 */
export const OtelAttrs = {
  // Shared correlation metadata — every event MUST carry eval.run_id (067 § 4.2;
  // kernel YAML `shared_attributes`). An event without it is malformed, not
  // "partial" (067 § 5).
  EVAL_RUN_ID: "eval.run_id",
  EVAL_SESSION_TRACE_ID: "eval.session_trace_id",
  TRACE_ID: "trace.id",

  // runtime.run.started payload (067 § 1.1).
  RUNTIME_RUN_SPEC_CONTENT_HASH: "runtime.run.spec_content_hash",
  RUNTIME_RUN_SKILL_SNAPSHOT_SHA: "runtime.run.skill_snapshot_sha",

  // runtime.run.finished payload (067 § 1.1).
  RUNTIME_RUN_TERMINAL_STATE: "runtime.run.terminal_state",
  RUNTIME_RUN_DURATION_MS: "runtime.run.duration_ms",

  // runtime.criterion.evaluated payload (067 § 1.1).
  RUNTIME_CRITERION_MATCHER_CLASS: "runtime.criterion.matcher_class",
  RUNTIME_CRITERION_OUTCOME: "runtime.criterion.outcome",
  // Multi-sample judging enrichment (additive): judge samples tallied for
  // this criterion + the fraction agreeing with the majority. Absent on
  // single-call and deterministic criteria. `agreement` below the spec's
  // stability threshold is the "verdict too noisy to trust" signal, queryable
  // without folding the N per-sample judge.verdict events.
  RUNTIME_CRITERION_SAMPLES: "runtime.criterion.samples",
  RUNTIME_CRITERION_AGREEMENT: "runtime.criterion.agreement",

  // judge.invoked payload (067 § 1.2).
  JUDGE_ID: "judge.id",
  JUDGE_MODEL_ID: "judge.model_id",
  JUDGE_MODEL_VERSION: "judge.model_version",

  // judge.verdict payload (067 § 1.2).
  JUDGE_VERDICT: "judge.verdict",
  JUDGE_VERDICT_SOURCE: "judge.verdict_source",
  JUDGE_SEED: "judge.seed",

  // gate.decision.emitted payload (067 § 2.2). Identical to iah-E07 spelling.
  GATE_NAME: "gate.name",
  GATE_DECISION: "gate.decision",
  GATE_POLICY_REF: "gate.policy_ref",

  // cost.run.recorded payload (minted here — see the cost.* note on OtelEvents).
  COST_RUN_TOTAL_INPUT_TOKENS: "cost.run.total_input_tokens",
  COST_RUN_TOTAL_OUTPUT_TOKENS: "cost.run.total_output_tokens",
  COST_RUN_TOTAL_CALLS: "cost.run.total_calls",
  // CRITICAL SEMANTIC: `estimated_usd` is OMITTED when unknown and
  // `cost.run.usd_known` (bool) is the discriminator. The cost report's null
  // (no rate on file) must NEVER render as 0 — $0 is a real price (free-tier
  // endpoints), and "unknown shown as free" is measured-wrong.
  COST_RUN_ESTIMATED_USD: "cost.run.estimated_usd",
  COST_RUN_USD_KNOWN: "cost.run.usd_known",

  // cost.phase.recorded payload (minted here — see the cost.* note on OtelEvents).
  COST_PHASE_NAME: "cost.phase.name",
  COST_PHASE_INPUT_TOKENS: "cost.phase.input_tokens",
  COST_PHASE_OUTPUT_TOKENS: "cost.phase.output_tokens",
  COST_PHASE_CALLS: "cost.phase.calls",
  // Judge phase only: the resolved samples-per-criterion multiplier — the ×N
  // that multi-sample majority voting applies to judge cost.
  COST_PHASE_JUDGE_SAMPLES: "cost.phase.judge_samples",
} as const;

export type OtelAttrKey = (typeof OtelAttrs)[keyof typeof OtelAttrs];

/**
 * Closed enum for `runtime.run.terminal_state` (067 § 1.1).
 * EvalRun terminal states per Blueprint B state machine.
 */
export const RuntimeTerminalState = {
  JUDGED: "judged",
  ARCHIVED_SUCCESS: "archived_success",
  ARCHIVED_FAILED: "archived_failed",
} as const;

export type RuntimeTerminalStateValue =
  (typeof RuntimeTerminalState)[keyof typeof RuntimeTerminalState];

/**
 * Closed enum for `runtime.criterion.outcome` (067 § 1.1).
 */
export const CriterionOutcome = {
  PASS: "pass",
  FAIL: "fail",
  SKIP: "skip",
} as const;

export type CriterionOutcomeValue = (typeof CriterionOutcome)[keyof typeof CriterionOutcome];

/**
 * Closed enum for `judge.verdict_source` (067 § 1.2). Aligns with the kernel
 * RuntimeReceipt `verdict_source` contract (iec-E06); the discriminator the
 * replay spec uses to bound RF level (066 § 1: an `llm_no_seed` verdict cannot
 * reach RF-2).
 */
export const JudgeVerdictSource = {
  LLM_WITH_SEED: "llm_with_seed",
  LLM_NO_SEED: "llm_no_seed",
  DETERMINISTIC: "deterministic",
} as const;

export type JudgeVerdictSourceValue = (typeof JudgeVerdictSource)[keyof typeof JudgeVerdictSource];

/**
 * Closed enum for `gate.decision` (067 § 2.2). The closed gate-result/v1
 * verdict enum (Blueprint B § 7.4 / kernel gate-result schema) — NOT the
 * RolloutGateDecision ship/no_ship vocabulary. Identical to iah-E07.
 */
export const GateDecision = {
  PASS: "pass",
  FAIL: "fail",
  ADVISORY: "advisory",
  ERROR: "error",
} as const;

export type GateDecisionValue = (typeof GateDecision)[keyof typeof GateDecision];

/**
 * Closed enum for `cost.phase.name` — the three strictly-sequential phases of
 * a per-model eval run, matching the CLI cost meter's `EvalPhase` vocabulary.
 */
export const CostPhaseName = {
  TRIGGER: "trigger",
  EXECUTION: "execution",
  JUDGE: "judge",
} as const;

export type CostPhaseNameValue = (typeof CostPhaseName)[keyof typeof CostPhaseName];
