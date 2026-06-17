import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emitOtelEvent, withEvalSpan } from "./emitter.js";
import { OtelEvents, OtelAttrs } from "./names.js";

/**
 * Capture process.stderr.write into an array of strings for assertion. The
 * emitter writes its `[OTEL]` / `[OTEL-DROP]` lines directly to
 * process.stderr (so structured stdout stays clean), so we spy there.
 */
function captureStderr() {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
  return { lines, spy };
}

describe("emitOtelEvent — stderr [OTEL]-marker transport", () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    const prevJrig = process.env.J_RIG_OTEL;
    const prevOtlp = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    restoreEnv = () => {
      if (prevJrig === undefined) delete process.env.J_RIG_OTEL;
      else process.env.J_RIG_OTEL = prevJrig;
      if (prevOtlp === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prevOtlp;
    };
    delete process.env.J_RIG_OTEL;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("is a no-op (no stderr output) when neither J_RIG_OTEL nor OTLP endpoint is set", () => {
    const { lines } = captureStderr();
    emitOtelEvent(OtelEvents.RUNTIME_RUN_STARTED, {
      [OtelAttrs.EVAL_RUN_ID]: "0192f8a0-0000-7000-8000-000000000000",
      [OtelAttrs.RUNTIME_RUN_SPEC_CONTENT_HASH]: "sha256:abc",
      [OtelAttrs.RUNTIME_RUN_SKILL_SNAPSHOT_SHA]: "sha256:def",
    });
    const otelLines = lines.filter((l) => l.startsWith("[OTEL"));
    expect(otelLines).toEqual([]);
  });

  it("emits an [OTEL]-prefixed single-line JSON when J_RIG_OTEL=1", () => {
    process.env.J_RIG_OTEL = "1";
    const { lines } = captureStderr();
    emitOtelEvent(OtelEvents.GATE_DECISION_EMITTED, {
      [OtelAttrs.EVAL_RUN_ID]: "0192f8a0-0000-7000-8000-000000000000",
      [OtelAttrs.GATE_NAME]: "j-rig-rollout-gate",
      [OtelAttrs.GATE_DECISION]: "pass",
      [OtelAttrs.GATE_POLICY_REF]: "sha256:policy",
    });
    const otelLine = lines.find((l) => l.startsWith("[OTEL] "));
    expect(otelLine).toBeDefined();
    const json = JSON.parse(otelLine!.replace(/^\[OTEL\] /, "").trimEnd());
    expect(json.name).toBe("gate.decision.emitted");
    expect(json.attributes["gate.decision"]).toBe("pass");
    expect(json.attributes["eval.run_id"]).toBe("0192f8a0-0000-7000-8000-000000000000");
  });

  it("emits when OTEL_EXPORTER_OTLP_ENDPOINT is set even without J_RIG_OTEL", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    const { lines } = captureStderr();
    emitOtelEvent(OtelEvents.JUDGE_VERDICT, {
      [OtelAttrs.EVAL_RUN_ID]: "0192f8a0-0000-7000-8000-000000000000",
      [OtelAttrs.JUDGE_VERDICT]: "yes",
      [OtelAttrs.JUDGE_VERDICT_SOURCE]: "llm_no_seed",
    });
    expect(lines.some((l) => l.startsWith("[OTEL] "))).toBe(true);
  });
});

describe("emitOtelEvent — required-metadata gate (067 § 4.2)", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    const prev = process.env.J_RIG_OTEL;
    restoreEnv = () => {
      if (prev === undefined) delete process.env.J_RIG_OTEL;
      else process.env.J_RIG_OTEL = prev;
    };
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("drops an event missing eval.run_id and emits an [OTEL-DROP] diagnostic when stderr emission is on", () => {
    process.env.J_RIG_OTEL = "1";
    const { lines } = captureStderr();
    emitOtelEvent(OtelEvents.JUDGE_INVOKED, {
      [OtelAttrs.JUDGE_ID]: "j-rig:judge:c1",
      // eval.run_id intentionally absent
    });
    expect(lines.some((l) => l.startsWith("[OTEL-DROP]"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[OTEL] "))).toBe(false);
  });

  it("drops silently (no diagnostic) when eval.run_id is missing AND stderr emission is off", () => {
    delete process.env.J_RIG_OTEL;
    const { lines } = captureStderr();
    emitOtelEvent(OtelEvents.JUDGE_INVOKED, { [OtelAttrs.JUDGE_ID]: "x" });
    expect(lines.filter((l) => l.startsWith("[OTEL"))).toEqual([]);
  });

  it("treats an empty-string eval.run_id as missing", () => {
    process.env.J_RIG_OTEL = "1";
    const { lines } = captureStderr();
    emitOtelEvent(OtelEvents.RUNTIME_RUN_FINISHED, {
      [OtelAttrs.EVAL_RUN_ID]: "",
      [OtelAttrs.RUNTIME_RUN_TERMINAL_STATE]: "judged",
    });
    expect(lines.some((l) => l.startsWith("[OTEL-DROP]"))).toBe(true);
  });
});

describe("emitOtelEvent — best-effort safety", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    const prev = process.env.J_RIG_OTEL;
    restoreEnv = () => {
      if (prev === undefined) delete process.env.J_RIG_OTEL;
      else process.env.J_RIG_OTEL = prev;
    };
    process.env.J_RIG_OTEL = "1";
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("never throws even if the stderr write itself throws", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("stderr exploded");
    });
    expect(() =>
      emitOtelEvent(OtelEvents.RUNTIME_RUN_STARTED, {
        [OtelAttrs.EVAL_RUN_ID]: "0192f8a0-0000-7000-8000-000000000000",
      }),
    ).not.toThrow();
  });

  it("strips null/undefined optional attributes from the emitted payload", () => {
    const { lines } = captureStderr();
    emitOtelEvent(OtelEvents.JUDGE_VERDICT, {
      [OtelAttrs.EVAL_RUN_ID]: "0192f8a0-0000-7000-8000-000000000000",
      [OtelAttrs.JUDGE_VERDICT]: "yes",
      [OtelAttrs.JUDGE_SEED]: null,
    });
    const otelLine = lines.find((l) => l.startsWith("[OTEL] "));
    const json = JSON.parse(otelLine!.replace(/^\[OTEL\] /, "").trimEnd());
    expect("judge.seed" in json.attributes).toBe(false);
    expect(json.attributes["judge.verdict"]).toBe("yes");
  });
});

describe("withEvalSpan", () => {
  it("runs the callback and returns its value when no provider is registered (no-op span)", async () => {
    const result = await withEvalSpan(
      "eval.test",
      { evalRunId: "0192f8a0-0000-7000-8000-000000000000" },
      async () => 42,
    );
    expect(result).toBe(42);
  });

  it("re-throws a callback error (telemetry observes but does not swallow pipeline errors)", async () => {
    await expect(
      withEvalSpan(
        "eval.test",
        { evalRunId: "0192f8a0-0000-7000-8000-000000000000", sessionTraceId: "s", traceId: "t" },
        async () => {
          throw new Error("pipeline boom");
        },
      ),
    ).rejects.toThrow("pipeline boom");
  });
});
