import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  emitRuntimeRunStarted,
  emitRuntimeRunFinished,
  emitRuntimeCriterionEvaluated,
  emitJudgeInvoked,
  emitJudgeVerdict,
  emitGateDecisionEmitted,
} from "./events.js";
import {
  RuntimeTerminalState,
  CriterionOutcome,
  JudgeVerdictSource,
  GateDecision,
} from "./names.js";

/** Capture the single [OTEL] JSON line a helper emits, parsed. */
function captureOneEvent(emit: () => void): { name: string; attributes: Record<string, unknown> } {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  emit();
  const otelLine = lines.find((l) => l.startsWith("[OTEL] "));
  if (!otelLine) throw new Error(`no [OTEL] line emitted; got: ${JSON.stringify(lines)}`);
  return JSON.parse(otelLine.replace(/^\[OTEL\] /, "").trimEnd());
}

const RUN_ID = "0192f8a0-0000-7000-8000-000000000000";
const correlation = { evalRunId: RUN_ID, sessionTraceId: "0192f8a0-1111-7000-8000-000000000000" };

describe("typed event helpers (067 §§ 1.1, 1.2, 2.2)", () => {
  let restore: () => void;
  beforeEach(() => {
    const prev = process.env.J_RIG_OTEL;
    restore = () => {
      if (prev === undefined) delete process.env.J_RIG_OTEL;
      else process.env.J_RIG_OTEL = prev;
    };
    process.env.J_RIG_OTEL = "1";
  });
  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  it("emitRuntimeRunStarted builds the § 1.1 payload with correlation metadata", () => {
    const ev = captureOneEvent(() =>
      emitRuntimeRunStarted(correlation, {
        specContentHash: "sha256:spec",
        skillSnapshotSha: "sha256:skill",
      }),
    );
    expect(ev.name).toBe("runtime.run.started");
    expect(ev.attributes["eval.run_id"]).toBe(RUN_ID);
    expect(ev.attributes["eval.session_trace_id"]).toBe(correlation.sessionTraceId);
    expect(ev.attributes["runtime.run.spec_content_hash"]).toBe("sha256:spec");
    expect(ev.attributes["runtime.run.skill_snapshot_sha"]).toBe("sha256:skill");
  });

  it("emitRuntimeRunFinished builds the § 1.1 terminal-state payload", () => {
    const ev = captureOneEvent(() =>
      emitRuntimeRunFinished(correlation, {
        terminalState: RuntimeTerminalState.JUDGED,
        durationMs: 1234,
      }),
    );
    expect(ev.name).toBe("runtime.run.finished");
    expect(ev.attributes["runtime.run.terminal_state"]).toBe("judged");
    expect(ev.attributes["runtime.run.duration_ms"]).toBe(1234);
  });

  it("emitRuntimeCriterionEvaluated builds the § 1.1 matcher/outcome payload", () => {
    const ev = captureOneEvent(() =>
      emitRuntimeCriterionEvaluated(correlation, {
        matcherClass: "judge",
        outcome: CriterionOutcome.FAIL,
      }),
    );
    expect(ev.name).toBe("runtime.criterion.evaluated");
    expect(ev.attributes["runtime.criterion.matcher_class"]).toBe("judge");
    expect(ev.attributes["runtime.criterion.outcome"]).toBe("fail");
  });

  it("emitJudgeInvoked builds the § 1.2 judge identity payload", () => {
    const ev = captureOneEvent(() =>
      emitJudgeInvoked(correlation, {
        judgeId: "j-rig:judge:c1",
        modelId: "claude-sonnet",
        modelVersion: "1.2.3",
      }),
    );
    expect(ev.name).toBe("judge.invoked");
    expect(ev.attributes["judge.id"]).toBe("j-rig:judge:c1");
    expect(ev.attributes["judge.model_id"]).toBe("claude-sonnet");
    expect(ev.attributes["judge.model_version"]).toBe("1.2.3");
  });

  it("emitJudgeVerdict omits a null seed and carries verdict_source (§ 1.2)", () => {
    const ev = captureOneEvent(() =>
      emitJudgeVerdict(correlation, {
        verdict: "yes",
        verdictSource: JudgeVerdictSource.LLM_NO_SEED,
        seed: null,
      }),
    );
    expect(ev.name).toBe("judge.verdict");
    expect(ev.attributes["judge.verdict"]).toBe("yes");
    expect(ev.attributes["judge.verdict_source"]).toBe("llm_no_seed");
    expect("judge.seed" in ev.attributes).toBe(false);
  });

  it("emitJudgeVerdict carries a numeric seed when provided (§ 1.2)", () => {
    const ev = captureOneEvent(() =>
      emitJudgeVerdict(correlation, {
        verdict: "no",
        verdictSource: JudgeVerdictSource.LLM_WITH_SEED,
        seed: 42,
      }),
    );
    expect(ev.attributes["judge.seed"]).toBe(42);
    expect(ev.attributes["judge.verdict_source"]).toBe("llm_with_seed");
  });

  it("emitGateDecisionEmitted matches the iah-E07 § 2.2 payload spelling", () => {
    const ev = captureOneEvent(() =>
      emitGateDecisionEmitted(correlation, {
        gateName: "j-rig-rollout-gate",
        decision: GateDecision.PASS,
        policyRef: "sha256:policy",
      }),
    );
    expect(ev.name).toBe("gate.decision.emitted");
    expect(ev.attributes["gate.name"]).toBe("j-rig-rollout-gate");
    expect(ev.attributes["gate.decision"]).toBe("pass");
    expect(ev.attributes["gate.policy_ref"]).toBe("sha256:policy");
  });
});
