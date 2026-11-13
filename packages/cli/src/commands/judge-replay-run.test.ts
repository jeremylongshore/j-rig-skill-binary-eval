import { describe, expect, it, vi } from "vitest";
import { admitReplay, replayDigest } from "./judge-replay-input.js";
import { replayJudgments } from "./judge-replay-run.js";

function admitted(samples = 3, repeats = 2) {
  const corpus = JSON.stringify({
    schema: "j-rig/judge-replay-corpus/v1",
    source: { revision: "synthetic", artifact_sha256: `sha256:${"0".repeat(64)}` },
    rows: [
      {
        id: "row",
        criterion: {
          id: "criterion",
          description: "Says hello",
          judge_prompt: "Does it say hello?",
        },
        prompt: "Greet",
        output: "hello\n",
      },
    ],
  });
  const review = JSON.stringify({
    schema: "j-rig/judge-replay-review/v1",
    corpus_sha256: replayDigest(corpus),
    reviewer: "synthetic-test-reviewer",
    reviewed_at: "2026-01-01T00:00:00Z",
    reviewed: true,
    labels: [{ id: "row", expected_verdict: "yes", rationale: "Synthetic greeting fixture" }],
  });
  return admitReplay(
    corpus,
    review,
    {
      provider: "groq",
      model: "offline",
      samples,
      repeats,
      temperature: 0.7,
      requests_per_minute: 30,
      judge_timeout_ms: 100,
      max_wall_ms: 10000,
      max_calls: 25,
    },
    new Date("2026-02-01"),
  );
}

describe("fixed-output judgment replay", () => {
  it("uses exact fixed bytes and existing majority semantics across repeats", async () => {
    const judge = vi
      .fn()
      .mockResolvedValue({ verdict: "yes", confidence: 1, reasoning: "offline" });
    const report = await replayJudgments(admitted(), { judge }, () => {});
    expect(judge).toHaveBeenCalledTimes(6);
    expect(
      judge.mock.calls.every(
        ([criterion, prompt, output, question]) =>
          criterion === "Says hello" &&
          prompt === "Greet" &&
          output === "hello\n" &&
          question === "Does it say hello?",
      ),
    ).toBe(true);
    expect(report.status).toBe("completed");
    expect(report.accuracy).toBe(1);
    expect(report.observations.map((row) => row.repeat)).toEqual([0, 1]);
    expect(report.observations[0]!.result.sample_verdicts).toEqual(["yes", "yes", "yes"]);
  });

  it("retains sample loss in majority denominator and failure accounting", async () => {
    const judge = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline failure"))
      .mockResolvedValue({ verdict: "yes", confidence: 1, reasoning: "offline" });
    const report = await replayJudgments(admitted(3, 1), { judge }, () => {});
    expect(report.failed_samples).toBe(1);
    expect(report).toMatchObject({
      status: "incomplete",
      completed_cells: 0,
      judged_cells: 1,
      degraded_cells: 1,
      correct: 1,
    });
    expect(report.observations[0]!.result.sample_verdicts).toEqual(["unsure", "yes", "yes"]);
    expect(report.observations[0]!.result.agreement).toBe(2 / 3);
  });

  it("never calls a provider after initial admission refusal", async () => {
    const judge = vi.fn();
    const report = await replayJudgments(admitted(), { judge }, () => {
      throw new Error("limit");
    });
    expect(judge).not.toHaveBeenCalled();
    expect(report.status).toBe("incomplete");
    expect(report.accuracy).toBe(0);
    expect(report.completed_cells).toBe(0);
  });

  it("separates a sample admission refusal from a provider invocation", async () => {
    const judge = vi.fn();
    let checks = 0;
    const report = await replayJudgments(admitted(1, 1), { judge }, () => {
      if (++checks > 1) throw new Error("admission limit");
    });
    expect(judge).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      status: "incomplete",
      provider_invocations: 0,
      failed_samples: 0,
      admission_refused_samples: 1,
    });
    expect(report.observations[0]!.sample_observations).toEqual([
      { sample: 0, status: "admission_refused", provider_invoked: false },
    ]);
  });

  it("marks the final cell incomplete when its last sample is refused", async () => {
    const judge = vi
      .fn()
      .mockResolvedValue({ verdict: "yes", confidence: 1, reasoning: "offline" });
    let checks = 0;
    const report = await replayJudgments(admitted(2, 1), { judge }, () => {
      if (++checks === 3) throw new Error("final sample admission");
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      status: "incomplete",
      completed_cells: 0,
      degraded_cells: 1,
      judged_cells: 1,
      provider_invocations: 1,
      admission_refused_samples: 1,
      failed_samples: 0,
    });
    expect(report.observations[0]!.result.sample_verdicts).toEqual(["yes", "unsure"]);
  });

  it("excludes degraded repeated cells from clean stability comparisons", async () => {
    const judge = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline loss"))
      .mockResolvedValue({ verdict: "yes", confidence: 1, reasoning: "offline" });
    const report = await replayJudgments(admitted(3, 2), { judge }, () => {});
    expect(report.status).toBe("incomplete");
    expect(report.degraded_cells).toBe(1);
    expect(report.repeat_stability.comparable_rows).toBe(0);
  });

  it("does not count total infrastructure failure as a completed judgment", async () => {
    const judge = vi.fn().mockRejectedValue(new Error("offline unavailable"));
    const report = await replayJudgments(admitted(1, 1), { judge }, () => {});
    expect(report.status).toBe("incomplete");
    expect(report.failed_samples).toBe(1);
    expect(report.completed_cells).toBe(0);
    expect(report.accuracy).toBe(0);
  });

  it("retains ordinary wrong and unsure verdicts without calling them infrastructure failures", async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce({ verdict: "no", confidence: 1, reasoning: "offline" })
      .mockResolvedValueOnce({ verdict: "unsure", confidence: 0, reasoning: "offline" });
    const report = await replayJudgments(admitted(1, 2), { judge }, () => {});
    expect(report.status).toBe("completed");
    expect(report.completed_cells).toBe(2);
    expect(report.failed_samples).toBe(0);
    expect(report.unsure).toBe(1);
    expect(report.correct).toBe(0);
    expect(report.repeat_stability).toEqual({
      measured: true,
      comparable_rows: 1,
      rows_with_disagreement: 1,
    });
  });
});
