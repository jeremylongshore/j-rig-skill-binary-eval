import { describe, it, expect } from "vitest";
import { judgeCriteria } from "./engine.js";
import { runCalibration } from "./calibration.js";
import type { JudgeProvider, GoldenCase } from "./types.js";
import { CriterionSchema } from "../schemas/criterion.js";
import type { Criterion } from "../schemas/criterion.js";

function criterion(partial: { id: string; description: string; method: "deterministic" | "judge"; deterministic_check?: string; judge_prompt?: string }): Criterion {
  return CriterionSchema.parse(partial);
}
import type { ObservedOutcome } from "../execution/types.js";
import { registerCheck } from "../checks/deterministic-registry.js";

function mockJudge(
  verdicts: Record<string, "yes" | "no" | "unsure">,
): JudgeProvider {
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
      criterion({ id: "c1", description: "Output contains hello", method: "deterministic", deterministic_check: "test_contains_hello" }),
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
      criterion({ id: "c2", description: "Output contains missing", method: "deterministic", deterministic_check: "test_contains_hello" }),
    ];

    const results = await judgeCriteria(criteria, makeOutcome("no match"), mockJudge({}));
    expect(results[0].verdict).toBe("no");
  });

  it("fails deterministic criterion with no check defined", async () => {
    const criteria: Criterion[] = [
      criterion({ id: "c3", description: "No check", method: "deterministic" }),
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
    const criteria: Criterion[] = [
      criterion({ id: "c5", description: "Fails", method: "judge" }),
    ];

    const provider: JudgeProvider = {
      async judge() { throw new Error("API down"); },
    };

    const results = await judgeCriteria(criteria, makeOutcome("text"), provider);
    expect(results[0].verdict).toBe("unsure");
    expect(results[0].confidence).toBe(0);
    expect(results[0].reasoning).toContain("API down");
  });

  it("routes deterministic before judge in mixed criteria", async () => {
    const criteria: Criterion[] = [
      criterion({ id: "det", description: "Deterministic", method: "deterministic", deterministic_check: "not_empty" }),
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

describe("calibration", () => {
  it("measures accuracy against golden cases", async () => {
    const goldenCases: GoldenCase[] = [
      { criterion_id: "g1", prompt: "p1", output: "o1", expected_verdict: "yes", explanation: "Should pass" },
      { criterion_id: "g2", prompt: "p2", output: "o2", expected_verdict: "no", explanation: "Should fail" },
      { criterion_id: "g3", prompt: "p3", output: "o3", expected_verdict: "yes", explanation: "Should pass too" },
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
      { criterion_id: "g1", prompt: "p", output: "o", expected_verdict: "yes", explanation: "Pass" },
    ];

    const provider = mockJudge({ "Pass": "yes" });
    const result = await runCalibration(goldenCases, provider);
    expect(result.accuracy).toBe(1);
    expect(result.mismatches).toHaveLength(0);
  });

  it("counts unsure as mismatch", async () => {
    const goldenCases: GoldenCase[] = [
      { criterion_id: "g1", prompt: "p", output: "o", expected_verdict: "yes", explanation: "Uncertain" },
    ];

    const provider = mockJudge({});  // returns unsure by default
    const result = await runCalibration(goldenCases, provider);
    expect(result.unsure).toBe(1);
    expect(result.correct).toBe(0);
    expect(result.mismatches).toHaveLength(1);
  });

  it("handles empty golden cases", async () => {
    const result = await runCalibration([], mockJudge({}));
    expect(result.accuracy).toBe(1);
    expect(result.total).toBe(0);
  });
});
