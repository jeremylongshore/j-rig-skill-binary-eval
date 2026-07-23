import { describe, it, expect } from "vitest";
import { judgeCriteria, DEFAULT_JUDGE_TIMEOUT_MS } from "./engine.js";
import { runCalibration } from "./calibration.js";
import type { JudgeProvider, GoldenCase } from "./types.js";
import { CriterionSchema } from "../schemas/criterion.js";
import type { Criterion } from "../schemas/criterion.js";

function criterion(partial: {
  id: string;
  description: string;
  method: "deterministic" | "judge";
  deterministic_check?: string;
  deterministic_check_params?: Record<string, unknown>;
  judge_prompt?: string;
}): Criterion {
  return CriterionSchema.parse(partial);
}
import type { ObservedOutcome } from "../execution/types.js";
import { registerCheck } from "../checks/deterministic-registry.js";

function mockJudge(verdicts: Record<string, "yes" | "no" | "unsure">): JudgeProvider {
  return {
    async judge(description) {
      const verdict = verdicts[description] ?? "unsure";
      return { verdict, confidence: 0.9, reasoning: `Mock: ${verdict}` };
    },
  };
}

function makeOutcome(text: string): ObservedOutcome {
  return {
    test_case_id: "t1",
    prompt: "test prompt",
    output: { text, artifacts: [], tool_calls: 0 },
    meta: { started_at: "", completed_at: "", duration_ms: 0, timed_out: false },
    status: "completed",
  };
}

describe("judgeCriteria", () => {
  it("judges deterministic criteria without LLM", async () => {
    registerCheck("test_contains_hello", (input) => input.includes("hello"));

    const criteria: Criterion[] = [
      criterion({
        id: "c1",
        description: "Output contains hello",
        method: "deterministic",
        deterministic_check: "test_contains_hello",
      }),
    ];

    const provider = mockJudge({});
    const results = await judgeCriteria(criteria, makeOutcome("hello world"), provider);

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("yes");
    expect(results[0].method).toBe("deterministic");
    expect(results[0].confidence).toBe(1);
  });

  it("fails deterministic check when not met", async () => {
    const criteria: Criterion[] = [
      criterion({
        id: "c2",
        description: "Output contains missing",
        method: "deterministic",
        deterministic_check: "test_contains_hello",
      }),
    ];

    const results = await judgeCriteria(criteria, makeOutcome("no match"), mockJudge({}));
    expect(results[0].verdict).toBe("no");
  });

  it("forwards deterministic_check_params: contains fails when the needle is absent [f-jrig-core-1]", async () => {
    const criteria: Criterion[] = [
      criterion({
        id: "c-params-miss",
        description: "Output contains the needle",
        method: "deterministic",
        deterministic_check: "contains",
        deterministic_check_params: { value: "needle" },
      }),
    ];

    // Before the fix, params were never forwarded to runCheck, the needle
    // defaulted to "" and EVERY output passed vacuously.
    const results = await judgeCriteria(criteria, makeOutcome("no match here"), mockJudge({}));
    expect(results[0].verdict).toBe("no");
  });

  it("forwards deterministic_check_params: contains passes when the needle is present [f-jrig-core-1]", async () => {
    const criteria: Criterion[] = [
      criterion({
        id: "c-params-hit",
        description: "Output contains the needle",
        method: "deterministic",
        deterministic_check: "contains",
        deterministic_check_params: { value: "needle" },
      }),
    ];

    const results = await judgeCriteria(
      criteria,
      makeOutcome("found the needle here"),
      mockJudge({}),
    );
    expect(results[0].verdict).toBe("yes");
  });

  it("parameterized check without params fails closed, not vacuously [f-jrig-core-1]", async () => {
    const criteria: Criterion[] = [
      criterion({
        id: "c-no-params",
        description: "Output contains something (params forgotten)",
        method: "deterministic",
        deterministic_check: "contains",
      }),
    ];

    const results = await judgeCriteria(criteria, makeOutcome("anything"), mockJudge({}));
    expect(results[0].verdict).toBe("no");
    expect(results[0].reasoning).toContain("requires params.value");
  });

  it("fails deterministic criterion with no check defined (engine guard, defense-in-depth)", async () => {
    // Spec-load now rejects a deterministic criterion with no check (Zod refine
    // on CriterionSchema), so this shape can no longer arrive via
    // CriterionSchema.parse. Construct it directly to exercise the engine's
    // belt-and-suspenders guard for any criterion that somehow reaches judgment
    // without passing through schema validation.
    const criteria: Criterion[] = [
      {
        id: "c3",
        description: "No check",
        method: "deterministic",
        blocker: false,
        regression_critical: false,
        baseline_sensitive: false,
        pack_sensitive: false,
      },
    ];

    const results = await judgeCriteria(criteria, makeOutcome("anything"), mockJudge({}));
    expect(results[0].verdict).toBe("no");
    expect(results[0].reasoning).toContain("no check defined");
  });

  it("judges criteria with LLM judge", async () => {
    const criteria: Criterion[] = [
      criterion({ id: "c4", description: "Output is helpful", method: "judge" }),
    ];

    const provider = mockJudge({ "Output is helpful": "yes" });
    const results = await judgeCriteria(criteria, makeOutcome("helpful output"), provider);

    expect(results[0].verdict).toBe("yes");
    expect(results[0].method).toBe("judge");
    expect(results[0].confidence).toBe(0.9);
  });

  it("handles judge errors as unsure", async () => {
    const criteria: Criterion[] = [criterion({ id: "c5", description: "Fails", method: "judge" })];

    const provider: JudgeProvider = {
      async judge() {
        throw new Error("API down");
      },
    };

    const results = await judgeCriteria(criteria, makeOutcome("text"), provider);
    expect(results[0].verdict).toBe("unsure");
    expect(results[0].confidence).toBe(0);
    expect(results[0].reasoning).toContain("API down");
  });

  it("routes deterministic before judge in mixed criteria", async () => {
    const criteria: Criterion[] = [
      criterion({
        id: "det",
        description: "Deterministic",
        method: "deterministic",
        deterministic_check: "not_empty",
      }),
      criterion({ id: "jdg", description: "Judge check", method: "judge" }),
    ];

    const provider = mockJudge({ "Judge check": "yes" });
    const results = await judgeCriteria(criteria, makeOutcome("content"), provider);

    expect(results[0].method).toBe("deterministic");
    expect(results[0].verdict).toBe("yes");
    expect(results[1].method).toBe("judge");
    expect(results[1].verdict).toBe("yes");
  });
});

describe("judgeCriteria — N-sample majority voting", () => {
  /** A judge that replays a scripted verdict sequence, one per call. */
  function sequenceJudge(
    script: Array<"yes" | "no" | "unsure" | Error>,
    calls?: Array<{ temperature?: number; timeout_ms?: number }>,
  ): JudgeProvider {
    let i = 0;
    return {
      async judge(_d, _p, _o, _jp, options) {
        calls?.push({ temperature: options?.temperature, timeout_ms: options?.timeout_ms });
        const step = script[i++];
        if (step === undefined) throw new Error("sequenceJudge exhausted");
        if (step instanceof Error) throw step;
        return { verdict: step, confidence: 0.9, reasoning: `sample says ${step}` };
      },
    };
  }

  const judgeCrit = (extra?: Record<string, unknown>): Criterion =>
    CriterionSchema.parse({
      id: "m1",
      description: "Subjective quality",
      method: "judge",
      ...extra,
    });

  it("majority-votes the verdict and reports agreement as confidence", async () => {
    const provider = sequenceJudge(["yes", "no", "yes", "yes", "no"]);
    const [r] = await judgeCriteria([judgeCrit()], makeOutcome("t"), provider, { samples: 5 });

    expect(r!.verdict).toBe("yes");
    expect(r!.samples).toBe(5);
    expect(r!.agreement).toBeCloseTo(3 / 5);
    expect(r!.confidence).toBeCloseTo(3 / 5);
    expect(r!.sample_verdicts).toEqual(["yes", "no", "yes", "yes", "no"]);
    expect(r!.reasoning).toContain("[3/5 yes]");
    expect(r!.reasoning).toContain("sample says yes");
  });

  it("abstains to unsure on a plurality tie", async () => {
    const provider = sequenceJudge(["yes", "no", "yes", "no"]);
    const [r] = await judgeCriteria([judgeCrit()], makeOutcome("t"), provider, { samples: 4 });

    expect(r!.verdict).toBe("unsure");
    expect(r!.agreement).toBeCloseTo(0.5);
    expect(r!.reasoning).toContain("tie");
  });

  it("counts errored samples as unsure votes — missing evidence weakens agreement", async () => {
    const provider = sequenceJudge(["yes", new Error("boom"), "yes"]);
    const [r] = await judgeCriteria([judgeCrit()], makeOutcome("t"), provider, { samples: 3 });

    expect(r!.verdict).toBe("yes");
    expect(r!.samples).toBe(3);
    expect(r!.agreement).toBeCloseTo(2 / 3);
    expect(r!.sample_verdicts).toEqual(["yes", "unsure", "yes"]);
    expect(r!.reasoning).toContain("errored");
  });

  it("never reports false certainty from a degraded run (1 success + 4 errors)", async () => {
    // Regression: dropping failures shrank the denominator — a 1-of-5 degraded
    // run reported agreement 1.0 with samples=1 and bypassed the stability
    // gate. With error→unsure votes the run reads as what it is: mostly
    // missing evidence.
    const provider = sequenceJudge([
      "no",
      new Error("down"),
      new Error("down"),
      new Error("down"),
      new Error("down"),
    ]);
    const [r] = await judgeCriteria([judgeCrit()], makeOutcome("t"), provider, { samples: 5 });

    expect(r!.verdict).toBe("unsure");
    expect(r!.samples).toBe(5);
    expect(r!.agreement).toBeCloseTo(4 / 5);
    expect(r!.sample_verdicts).toEqual(["no", "unsure", "unsure", "unsure", "unsure"]);
  });

  it("degrades to the legacy error result when every sample fails", async () => {
    const provider = sequenceJudge([new Error("down"), new Error("down"), new Error("down")]);
    const [r] = await judgeCriteria([judgeCrit()], makeOutcome("t"), provider, { samples: 3 });

    expect(r!.verdict).toBe("unsure");
    expect(r!.confidence).toBe(0);
    expect(r!.reasoning).toContain("down");
    expect(r!.samples).toBeUndefined();
  });

  it("keeps the legacy single-call result shape when samples is 1 or unset", async () => {
    const provider = sequenceJudge(["yes"]);
    const [r] = await judgeCriteria([judgeCrit()], makeOutcome("t"), provider, { samples: 1 });

    expect(r!.verdict).toBe("yes");
    expect(r!.confidence).toBe(0.9); // provider-reported, not agreement
    expect(r!.samples).toBeUndefined();
    expect(r!.agreement).toBeUndefined();
    expect(r!.sample_verdicts).toBeUndefined();
  });

  it("lets a criterion's own samples override the run-level default", async () => {
    const provider = sequenceJudge(["yes", "yes", "yes"]);
    const [r] = await judgeCriteria([judgeCrit({ samples: 3 })], makeOutcome("t"), provider, {
      samples: 1,
    });

    expect(r!.samples).toBe(3);
    expect(r!.agreement).toBe(1);
  });

  it("threads judge temperature through to the provider, criterion override first", async () => {
    const calls: Array<{ temperature?: number }> = [];
    const provider = sequenceJudge(["yes", "yes"], calls);
    await judgeCriteria([judgeCrit({ judge_temperature: 0.7 })], makeOutcome("t"), provider, {
      samples: 2,
      judgeTemperature: 0.2,
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.temperature === 0.7)).toBe(true);
  });

  it("passes no temperature — but always the default timeout — when neither level sets one", async () => {
    const calls: Array<{ temperature?: number; timeout_ms?: number }> = [];
    const provider = sequenceJudge(["yes"], calls);
    await judgeCriteria([judgeCrit()], makeOutcome("t"), provider);

    // The default per-call timeout is the one deliberate behavior change from
    // the legacy no-options path: an unbounded judge hang is never right.
    expect(calls).toEqual([{ temperature: undefined, timeout_ms: DEFAULT_JUDGE_TIMEOUT_MS }]);
  });

  it("defaults multi-sample runs to temperature 0.7 when none is configured", async () => {
    // Majority voting needs independent draws; sampling a nearly-collapsed
    // temperature-0 distribution understates variance while multiplying cost.
    const calls: Array<{ temperature?: number }> = [];
    const provider = sequenceJudge(["yes", "yes", "yes"], calls);
    await judgeCriteria([judgeCrit()], makeOutcome("t"), provider, { samples: 3 });

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.temperature === 0.7)).toBe(true);
  });
});

describe("judgeCriteria — sampling robustness (timeout, pacing, per-sample timing)", () => {
  const robustCrit = (): Criterion =>
    CriterionSchema.parse({ id: "r1", description: "Subjective quality", method: "judge" });

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const yes = { verdict: "yes" as const, confidence: 0.9, reasoning: "ok" };

  it("threads the default 120s timeout into single-call AND multi-sample judge calls", async () => {
    const seen: Array<number | undefined> = [];
    const provider: JudgeProvider = {
      async judge(_d, _p, _o, _jp, options) {
        seen.push(options?.timeout_ms);
        return yes;
      },
    };
    await judgeCriteria([robustCrit()], makeOutcome("t"), provider);
    await judgeCriteria([robustCrit()], makeOutcome("t"), provider, { samples: 3 });

    expect(DEFAULT_JUDGE_TIMEOUT_MS).toBe(120_000);
    expect(seen).toEqual([120_000, 120_000, 120_000, 120_000]);
  });

  it("honors a judgeTimeoutMs override on every call", async () => {
    const seen: Array<number | undefined> = [];
    const provider: JudgeProvider = {
      async judge(_d, _p, _o, _jp, options) {
        seen.push(options?.timeout_ms);
        return yes;
      },
    };
    await judgeCriteria([robustCrit()], makeOutcome("t"), provider, {
      samples: 2,
      judgeTimeoutMs: 30_000,
    });

    expect(seen).toEqual([30_000, 30_000]);
  });

  it("rejects non-positive and non-finite programmatic timeout overrides", async () => {
    const seen: Array<number | undefined> = [];
    const provider: JudgeProvider = {
      async judge(_d, _p, _o, _jp, options) {
        seen.push(options?.timeout_ms);
        return yes;
      },
    };

    for (const judgeTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await judgeCriteria([robustCrit()], makeOutcome("t"), provider, { judgeTimeoutMs });
    }

    expect(seen).toEqual([
      DEFAULT_JUDGE_TIMEOUT_MS,
      DEFAULT_JUDGE_TIMEOUT_MS,
      DEFAULT_JUDGE_TIMEOUT_MS,
      DEFAULT_JUDGE_TIMEOUT_MS,
    ]);
  });

  it("respects the sampleConcurrency bound — max in-flight tracked in the mock", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const provider: JudgeProvider = {
      async judge() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(5);
        inFlight--;
        return yes;
      },
    };
    const [r] = await judgeCriteria([robustCrit()], makeOutcome("t"), provider, {
      samples: 6,
      sampleConcurrency: 2,
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(r!.samples).toBe(6);
    expect(r!.sample_verdicts).toHaveLength(6);
    expect(r!.verdict).toBe("yes");
  });

  it("keeps all N samples concurrent when no bound is set (legacy dispatch)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const provider: JudgeProvider = {
      async judge() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(5);
        inFlight--;
        return yes;
      },
    };
    await judgeCriteria([robustCrit()], makeOutcome("t"), provider, { samples: 5 });

    expect(maxInFlight).toBe(5);
  });

  it("normalizes invalid programmatic sampleConcurrency values instead of returning holes", async () => {
    for (const sampleConcurrency of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      let calls = 0;
      const provider: JudgeProvider = {
        async judge() {
          calls++;
          return yes;
        },
      };
      const [result] = await judgeCriteria([robustCrit()], makeOutcome("t"), provider, {
        samples: 3,
        sampleConcurrency,
      });

      expect(calls).toBe(3);
      expect(result!.sample_verdicts).toEqual(["yes", "yes", "yes"]);
      expect(result!.agreement).toBe(1);
    }
  });

  it("keeps sample_verdicts aligned to dispatch order when completions reorder", async () => {
    // Call 0 is slow, calls 1..3 fast: with a bound of 2 the completion order
    // is 1,2,3,0 — the recorded verdicts must still follow dispatch order.
    const script = [
      { verdict: "no" as const, delayMs: 40 },
      { verdict: "yes" as const, delayMs: 1 },
      { verdict: "yes" as const, delayMs: 1 },
      { verdict: "yes" as const, delayMs: 1 },
    ];
    let i = 0;
    const provider: JudgeProvider = {
      async judge() {
        const step = script[i++]!;
        await delay(step.delayMs);
        return { verdict: step.verdict, confidence: 0.9, reasoning: `sample says ${step.verdict}` };
      },
    };
    const [r] = await judgeCriteria([robustCrit()], makeOutcome("t"), provider, {
      samples: 4,
      sampleConcurrency: 2,
    });

    expect(r!.sample_verdicts).toEqual(["no", "yes", "yes", "yes"]);
    expect(r!.sample_latencies_ms).toHaveLength(4);
    expect(r!.verdict).toBe("yes");
  });

  it("folds a timed-out sample into an unsure vote and completes the run", async () => {
    // A provider that honors timeout_ms the way the real adapters do: the call
    // rejects when the simulated completion outlives the budget.
    let call = 0;
    const provider: JudgeProvider = {
      judge(_d, _p, _o, _jp, options) {
        const latency = call++ === 0 ? 1_000 : 1;
        return new Promise((resolve, reject) => {
          const done = setTimeout(() => resolve(yes), latency);
          if (options?.timeout_ms !== undefined && options.timeout_ms < latency) {
            setTimeout(() => {
              clearTimeout(done);
              reject(new Error("judge call timed out"));
            }, options.timeout_ms);
          }
        });
      },
    };
    const [r] = await judgeCriteria([robustCrit()], makeOutcome("t"), provider, {
      samples: 3,
      judgeTimeoutMs: 20,
    });

    expect(r!.verdict).toBe("yes");
    expect(r!.sample_verdicts).toEqual(["unsure", "yes", "yes"]);
    expect(r!.agreement).toBeCloseTo(2 / 3);
    expect(r!.reasoning).toContain("errored");
    // The timed-out sample still records its (bounded) latency. The lower
    // bound is slack (15 < the 20ms budget): Node timers may fire ~1ms early
    // relative to Date.now() deltas.
    expect(r!.sample_latencies_ms).toHaveLength(3);
    expect(r!.sample_latencies_ms![0]).toBeGreaterThanOrEqual(15);
  });

  it("records per-sample latencies aligned index-for-index with verdicts (multi-sample only)", async () => {
    const provider: JudgeProvider = {
      async judge() {
        await delay(2);
        return yes;
      },
    };
    const [r] = await judgeCriteria([robustCrit()], makeOutcome("t"), provider, { samples: 3 });

    expect(r!.sample_latencies_ms).toHaveLength(3);
    expect(r!.sample_latencies_ms!.length).toBe(r!.sample_verdicts!.length);
    for (const ms of r!.sample_latencies_ms!) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the single-call result shape latency-free", async () => {
    const provider: JudgeProvider = {
      async judge() {
        return yes;
      },
    };
    const [r] = await judgeCriteria([robustCrit()], makeOutcome("t"), provider, { samples: 1 });

    expect(r!.verdict).toBe("yes");
    expect(r!.sample_latencies_ms).toBeUndefined();
  });

  it("omits latencies on the degraded all-error legacy shape", async () => {
    const provider: JudgeProvider = {
      async judge() {
        throw new Error("down");
      },
    };
    const [r] = await judgeCriteria([robustCrit()], makeOutcome("t"), provider, { samples: 3 });

    expect(r!.verdict).toBe("unsure");
    expect(r!.samples).toBeUndefined();
    expect(r!.sample_latencies_ms).toBeUndefined();
  });
});

describe("calibration", () => {
  it("bounds every calibration judge call with the default timeout", async () => {
    const seen: Array<number | undefined> = [];
    const provider: JudgeProvider = {
      async judge(_d, _p, _o, _jp, options) {
        seen.push(options?.timeout_ms);
        return { verdict: "yes", confidence: 1, reasoning: "ok" };
      },
    };
    const goldenCases: GoldenCase[] = [
      {
        criterion_id: "bounded",
        prompt: "p",
        output: "o",
        expected_verdict: "yes",
        explanation: "Pass",
      },
    ];

    await runCalibration(goldenCases, provider);

    expect(seen).toEqual([DEFAULT_JUDGE_TIMEOUT_MS]);
  });

  it("measures accuracy against golden cases", async () => {
    const goldenCases: GoldenCase[] = [
      {
        criterion_id: "g1",
        prompt: "p1",
        output: "o1",
        expected_verdict: "yes",
        explanation: "Should pass",
      },
      {
        criterion_id: "g2",
        prompt: "p2",
        output: "o2",
        expected_verdict: "no",
        explanation: "Should fail",
      },
      {
        criterion_id: "g3",
        prompt: "p3",
        output: "o3",
        expected_verdict: "yes",
        explanation: "Should pass too",
      },
    ];

    const provider = mockJudge({
      "Should pass": "yes",
      "Should fail": "no",
      "Should pass too": "no", // wrong!
    });

    const result = await runCalibration(goldenCases, provider);
    expect(result.total).toBe(3);
    expect(result.correct).toBe(2);
    expect(result.incorrect).toBe(1);
    expect(result.accuracy).toBeCloseTo(2 / 3);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].criterion_id).toBe("g3");
  });

  it("handles perfect calibration", async () => {
    const goldenCases: GoldenCase[] = [
      {
        criterion_id: "g1",
        prompt: "p",
        output: "o",
        expected_verdict: "yes",
        explanation: "Pass",
      },
    ];

    const provider = mockJudge({ Pass: "yes" });
    const result = await runCalibration(goldenCases, provider);
    expect(result.accuracy).toBe(1);
    expect(result.mismatches).toHaveLength(0);
  });

  it("counts unsure as mismatch", async () => {
    const goldenCases: GoldenCase[] = [
      {
        criterion_id: "g1",
        prompt: "p",
        output: "o",
        expected_verdict: "yes",
        explanation: "Uncertain",
      },
    ];

    const provider = mockJudge({}); // returns unsure by default
    const result = await runCalibration(goldenCases, provider);
    expect(result.unsure).toBe(1);
    expect(result.correct).toBe(0);
    expect(result.mismatches).toHaveLength(1);
  });

  it("fails CLOSED on empty golden cases (accuracy 0, not a vacuous 100%) [f-jrig-core-4]", async () => {
    const result = await runCalibration([], mockJudge({}));
    expect(result.accuracy).toBe(0);
    expect(result.total).toBe(0);
  });
});
