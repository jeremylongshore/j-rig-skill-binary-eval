import { describe, it, expect } from "vitest";
import {
  OtelEvents,
  OtelAttrs,
  RuntimeTerminalState,
  CriterionOutcome,
  JudgeVerdictSource,
  GateDecision,
  CostPhaseName,
} from "./names.js";

/**
 * Drift-guard: these assertions pin the exact spellings the 067 taxonomy
 * (intent-eval-lab/000-docs/067-AT-SPEC-runtime-event-taxonomy-2026-06-12.md)
 * + the kernel YAML (intent-eval-core/schemas/v1/otel-attributes.yaml) define.
 * If the spec changes a name, THIS test must change in lock-step — making any
 * accidental drift in the constants a loud test failure (the exact Gregg
 * finding #2 hazard the cross-emitter pin guards against). The audit-harness
 * iah-E07 emitter must agree with the gate.* spellings here.
 */
describe("OTel event names (067 § 1.1, 1.2, 2.2)", () => {
  it("pins the runtime.* execution event names verbatim (§ 1.1)", () => {
    expect(OtelEvents.RUNTIME_RUN_STARTED).toBe("runtime.run.started");
    expect(OtelEvents.RUNTIME_RUN_FINISHED).toBe("runtime.run.finished");
    expect(OtelEvents.RUNTIME_CRITERION_EVALUATED).toBe("runtime.criterion.evaluated");
  });

  it("pins the judge.* event names verbatim (§ 1.2)", () => {
    expect(OtelEvents.JUDGE_INVOKED).toBe("judge.invoked");
    expect(OtelEvents.JUDGE_VERDICT).toBe("judge.verdict");
  });

  it("pins the gate.* governance event name verbatim, matching iah-E07 (§ 2.2)", () => {
    expect(OtelEvents.GATE_DECISION_EMITTED).toBe("gate.decision.emitted");
  });

  it("pins the cost.* run-end summary event names (minted here; 067 reserved category)", () => {
    expect(OtelEvents.COST_RUN_RECORDED).toBe("cost.run.recorded");
    expect(OtelEvents.COST_PHASE_RECORDED).toBe("cost.phase.recorded");
  });

  it("every event name is dotted-lowercase with snake_case leaves (§ 4.1)", () => {
    for (const name of Object.values(OtelEvents)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });
});

describe("OTel attribute keys", () => {
  it("pins the shared correlation keys owned by the kernel YAML (§ 4.2)", () => {
    expect(OtelAttrs.EVAL_RUN_ID).toBe("eval.run_id");
    expect(OtelAttrs.EVAL_SESSION_TRACE_ID).toBe("eval.session_trace_id");
    expect(OtelAttrs.TRACE_ID).toBe("trace.id");
  });

  it("pins the runtime.run.* payload keys (§ 1.1)", () => {
    expect(OtelAttrs.RUNTIME_RUN_SPEC_CONTENT_HASH).toBe("runtime.run.spec_content_hash");
    expect(OtelAttrs.RUNTIME_RUN_SKILL_SNAPSHOT_SHA).toBe("runtime.run.skill_snapshot_sha");
    expect(OtelAttrs.RUNTIME_RUN_TERMINAL_STATE).toBe("runtime.run.terminal_state");
    expect(OtelAttrs.RUNTIME_RUN_DURATION_MS).toBe("runtime.run.duration_ms");
  });

  it("pins the runtime.criterion.* payload keys (§ 1.1)", () => {
    expect(OtelAttrs.RUNTIME_CRITERION_MATCHER_CLASS).toBe("runtime.criterion.matcher_class");
    expect(OtelAttrs.RUNTIME_CRITERION_OUTCOME).toBe("runtime.criterion.outcome");
  });

  it("pins the judge.* payload keys (§ 1.2)", () => {
    expect(OtelAttrs.JUDGE_ID).toBe("judge.id");
    expect(OtelAttrs.JUDGE_MODEL_ID).toBe("judge.model_id");
    expect(OtelAttrs.JUDGE_MODEL_VERSION).toBe("judge.model_version");
    expect(OtelAttrs.JUDGE_VERDICT).toBe("judge.verdict");
    expect(OtelAttrs.JUDGE_VERDICT_SOURCE).toBe("judge.verdict_source");
    expect(OtelAttrs.JUDGE_SEED).toBe("judge.seed");
  });

  it("pins the gate.decision.emitted payload keys, matching iah-E07 (§ 2.2)", () => {
    expect(OtelAttrs.GATE_NAME).toBe("gate.name");
    expect(OtelAttrs.GATE_DECISION).toBe("gate.decision");
    expect(OtelAttrs.GATE_POLICY_REF).toBe("gate.policy_ref");
  });

  it("pins the cost.run.recorded payload keys (minted here)", () => {
    expect(OtelAttrs.COST_RUN_TOTAL_INPUT_TOKENS).toBe("cost.run.total_input_tokens");
    expect(OtelAttrs.COST_RUN_TOTAL_OUTPUT_TOKENS).toBe("cost.run.total_output_tokens");
    expect(OtelAttrs.COST_RUN_TOTAL_CALLS).toBe("cost.run.total_calls");
    expect(OtelAttrs.COST_RUN_ESTIMATED_USD).toBe("cost.run.estimated_usd");
    expect(OtelAttrs.COST_RUN_USD_KNOWN).toBe("cost.run.usd_known");
  });

  it("pins the cost.phase.recorded payload keys (minted here)", () => {
    expect(OtelAttrs.COST_PHASE_NAME).toBe("cost.phase.name");
    expect(OtelAttrs.COST_PHASE_INPUT_TOKENS).toBe("cost.phase.input_tokens");
    expect(OtelAttrs.COST_PHASE_OUTPUT_TOKENS).toBe("cost.phase.output_tokens");
    expect(OtelAttrs.COST_PHASE_CALLS).toBe("cost.phase.calls");
    expect(OtelAttrs.COST_PHASE_JUDGE_SAMPLES).toBe("cost.phase.judge_samples_default");
  });

  it("every attribute key is dotted-lowercase with snake_case leaves (§ 4.1)", () => {
    for (const key of Object.values(OtelAttrs)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });
});

describe("OTel closed enums", () => {
  it("runtime.run.terminal_state enum (§ 1.1)", () => {
    expect(Object.values(RuntimeTerminalState).sort()).toEqual(
      ["archived_failed", "archived_success", "judged"].sort(),
    );
  });

  it("runtime.criterion.outcome enum (§ 1.1)", () => {
    expect(Object.values(CriterionOutcome).sort()).toEqual(["fail", "pass", "skip"].sort());
  });

  it("judge.verdict_source enum aligns with the kernel RuntimeReceipt (§ 1.2)", () => {
    expect(Object.values(JudgeVerdictSource).sort()).toEqual(
      ["deterministic", "llm_no_seed", "llm_with_seed"].sort(),
    );
  });

  it("gate.decision enum is the closed gate-result/v1 verdict set (§ 2.2)", () => {
    expect(Object.values(GateDecision).sort()).toEqual(
      ["advisory", "error", "fail", "pass"].sort(),
    );
  });

  it("cost.phase.name enum is the closed per-model eval phase set", () => {
    expect(Object.values(CostPhaseName).sort()).toEqual(["execution", "judge", "trigger"].sort());
  });
});
