import { afterEach, describe, expect, it, vi } from "vitest";
import { emitCostPhaseRecorded, emitCostRunRecorded } from "@j-rig/core";
import { EvalCostMeter } from "../providers/cost-tracking.js";
import { reportEvalCost } from "./eval-cost-report.js";

vi.mock("@j-rig/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@j-rig/core")>()),
  emitCostPhaseRecorded: vi.fn(),
  emitCostRunRecorded: vi.fn(),
}));

const correlation = { evalRunId: "0192f8a0-0000-7000-8000-000000000000" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("settled eval cost reporting", () => {
  it("does not invent cost or telemetry for an unmetered run", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    reportEvalCost(null, {}, correlation, undefined);
    expect(log).not.toHaveBeenCalled();
    expect(emitCostPhaseRecorded).not.toHaveBeenCalled();
    expect(emitCostRunRecorded).not.toHaveBeenCalled();
  });

  it("emits ordered phase and run summaries in JSON mode without console text", () => {
    const meter = new EvalCostMeter();
    meter.record("unknown-model", null);
    meter.phase = "execution";
    meter.record("unknown-model", { inputTokens: 3, outputTokens: 4 });
    meter.phase = "judge";
    meter.record("unknown-model", null);
    const report = meter.report();
    const snapshot = structuredClone(report);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    reportEvalCost(report, { json: true }, correlation, 5);
    expect(log).not.toHaveBeenCalled();
    expect(vi.mocked(emitCostPhaseRecorded).mock.calls).toEqual([
      [
        correlation,
        { phase: "trigger", inputTokens: 0, outputTokens: 0, calls: 1, unknownCalls: 1 },
      ],
      [
        correlation,
        { phase: "execution", inputTokens: 3, outputTokens: 4, calls: 1, unknownCalls: 0 },
      ],
      [
        correlation,
        {
          phase: "judge",
          inputTokens: 0,
          outputTokens: 0,
          calls: 1,
          unknownCalls: 1,
          judgeSamples: 5,
        },
      ],
    ]);
    expect(emitCostRunRecorded).toHaveBeenCalledWith(correlation, {
      totalInputTokens: 3,
      totalOutputTokens: 4,
      totalCalls: 3,
      estimatedUsd: null,
      usageComplete: false,
      unknownCalls: 2,
    });
    expect(vi.mocked(emitCostPhaseRecorded).mock.invocationCallOrder[2]).toBeLessThan(
      vi.mocked(emitCostRunRecorded).mock.invocationCallOrder[0],
    );
    expect(report).toEqual(snapshot);
  });

  it("prints an explicit unknown estimate and defaults judge samples to one", () => {
    const meter = new EvalCostMeter();
    meter.record("unpriced-model", null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    reportEvalCost(meter.report(), {}, correlation, undefined);
    expect(log.mock.calls).toEqual([
      [
        "  Eval cost: 0 in / 0 out tokens, 1 calls (1 unmeasured; tokens are known subtotals) (trigger 1, execution 0, judge 0)",
      ],
      ["    estimated: n/a (a model has no rate on file) — unpriced-model: no rate on file"],
    ]);
    expect(emitCostPhaseRecorded).toHaveBeenLastCalledWith(correlation, {
      phase: "judge",
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      unknownCalls: 0,
      judgeSamples: 1,
    });
  });

  it("keeps measured zero dollars distinct from an unknown rate", () => {
    const meter = new EvalCostMeter();
    meter.record("openai/gpt-oss-120b", { inputTokens: 10, outputTokens: 5 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    reportEvalCost(meter.report(), {}, correlation, 1);
    expect(log.mock.calls[1]).toEqual(["    estimated: $0.0000 — openai/gpt-oss-120b: $0.0000"]);
    expect(emitCostRunRecorded).toHaveBeenCalledWith(
      correlation,
      expect.objectContaining({ estimatedUsd: 0, usageComplete: true }),
    );
  });

  it("labels API-equivalent subscription usage separately from billed dollars", () => {
    const meter = new EvalCostMeter();
    meter.phase = "execution";
    meter.record("claude-code/claude-haiku-4-5", { inputTokens: 1000000, outputTokens: 0 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    reportEvalCost(meter.report(), {}, correlation, 1);
    expect(log.mock.calls[1]).toEqual([
      "    estimated: $1.0000 (billed $0.0000; the rest is API-equivalent claude-code subscription usage, not billed) — claude-code/claude-haiku-4-5: $1.0000",
    ]);
  });
});
