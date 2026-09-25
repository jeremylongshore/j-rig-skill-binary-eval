import { describe, expect, it } from "vitest";
import type { JudgmentResult, ObservedOutcome } from "@j-rig/core";
import {
  detectInfrastructureFailure,
  infrastructureFailureReason,
  isFailedExecution,
} from "./eval-infrastructure-failure.js";

function outcome(id: string, patch: Partial<ObservedOutcome> = {}): ObservedOutcome {
  return {
    test_case_id: id,
    prompt: `prompt for ${id}`,
    status: "completed",
    output: { text: "an answer", artifacts: [], tool_calls: 0 },
    meta: {
      model: "m",
      duration_ms: 1,
      timed_out: false,
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:00.001Z",
    },
    ...patch,
  } as ObservedOutcome;
}

function judgment(id: string, patch: Partial<JudgmentResult> = {}): JudgmentResult {
  return {
    criterion_id: id,
    verdict: "yes",
    confidence: 1,
    reasoning: "ok",
    method: "judge",
    ...patch,
  } as JudgmentResult;
}

const providers = { executionProvider: "exec-co", judgeProvider: "judge-co" };

describe("detectInfrastructureFailure", () => {
  it("returns null for a complete evaluation, including a genuine `unsure` verdict", () => {
    expect(
      detectInfrastructureFailure({
        outcomes: [outcome("a"), outcome("b")],
        judgments: [judgment("c1"), judgment("c2", { verdict: "unsure", confidence: 0.4 })],
        ...providers,
      }),
    ).toBeNull();
  });

  it("keeps a completed-but-empty response as boundary evidence, not a failure", () => {
    const empty = outcome("a", { output: { text: "", artifacts: [], tool_calls: 0 } });
    expect(isFailedExecution(empty)).toBe(false);
    expect(
      detectInfrastructureFailure({ outcomes: [empty], judgments: [], ...providers }),
    ).toBeNull();
  });

  it("does not treat a deterministic criterion's `unsure` as a judge outage", () => {
    expect(
      detectInfrastructureFailure({
        outcomes: [outcome("a")],
        judgments: [judgment("d1", { method: "deterministic", verdict: "unsure" })],
        ...providers,
      }),
    ).toBeNull();
  });

  it("classifies a typed execution failure and counts every affected test case", () => {
    const failed = (id: string) =>
      outcome(id, {
        status: "failed",
        output: { text: "", artifacts: [], tool_calls: 0, error: "Insufficient Balance" },
        provider_failure: { category: "rate_limit", providerName: "deepseek", retryable: false },
      });
    const failure = detectInfrastructureFailure({
      outcomes: [failed("a"), outcome("b"), failed("c")],
      judgments: [],
      ...providers,
    });
    expect(failure).toEqual({
      type: "provider_failure",
      phase: "execution",
      provider: "deepseek",
      category: "rate_limit",
      retryable: false,
      affected: 2,
      total: 3,
      message: "Insufficient Balance",
    });
    expect(infrastructureFailureReason(failure!)).toBe(
      "provider_failure/execution [deepseek rate_limit]: execution provider failed on 2 of 3 " +
        "test case(s); the skill was not exercised: Insufficient Balance",
    );
  });

  it("falls back to a retryable network_timeout for an untyped timeout", () => {
    const failure = detectInfrastructureFailure({
      outcomes: [outcome("a", { status: "timed_out" })],
      judgments: [],
      ...providers,
    });
    expect(failure).toMatchObject({
      phase: "execution",
      provider: "exec-co",
      category: "network_timeout",
      retryable: true,
      message: "execution ended with status timed_out",
    });
    expect(infrastructureFailureReason(failure!)).toContain("[exec-co network_timeout, retryable]");
  });

  it("falls back to `unknown` for an untyped execution error on a completed status", () => {
    const failure = detectInfrastructureFailure({
      outcomes: [
        outcome("a", { output: { text: "", artifacts: [], tool_calls: 0, error: "boom" } }),
      ],
      judgments: [],
      ...providers,
    });
    expect(failure).toMatchObject({ category: "unknown", retryable: false, message: "boom" });
  });

  it("reports execution ahead of judge when both phases failed", () => {
    const failure = detectInfrastructureFailure({
      outcomes: [outcome("a", { status: "failed" })],
      judgments: [judgment("c1", { verdict: "unsure", judge_error: "HTTP 401" })],
      ...providers,
    });
    expect(failure?.phase).toBe("execution");
  });

  it("flags a PARTIAL judge outage and says the evaluation is incomplete", () => {
    const failure = detectInfrastructureFailure({
      outcomes: [outcome("a")],
      judgments: [
        judgment("c1"),
        judgment("c2", {
          verdict: "unsure",
          judge_error: "HTTP 429 slow down",
          provider_failure: { category: "rate_limit", providerName: "groq", retryable: true },
        }),
        judgment("c3"),
      ],
      ...providers,
    });
    expect(failure).toMatchObject({
      phase: "judge",
      provider: "groq",
      category: "rate_limit",
      retryable: true,
      affected: 1,
      total: 3,
    });
    expect(infrastructureFailureReason(failure!)).toBe(
      "provider_failure/judge [groq rate_limit, retryable]: judge provider failed on 1 of 3 " +
        "judged criteria; the evaluation is incomplete: HTTP 429 slow down",
    );
  });

  it("keeps the original dead-judge wording when every judged criterion failed", () => {
    const failure = detectInfrastructureFailure({
      outcomes: [outcome("a")],
      judgments: [
        judgment("c1", { verdict: "unsure", judge_error: "HTTP 401 authentication" }),
        judgment("d1", { method: "deterministic" }),
      ],
      ...providers,
    });
    expect(failure).toMatchObject({ provider: "judge-co", category: "unknown", total: 1 });
    expect(infrastructureFailureReason(failure!)).toContain(
      "judge provider failed on every judged criterion (1/1); nothing was evaluated: HTTP 401",
    );
  });

  it("redacts credentials before the message can reach a signed row", () => {
    const failure = detectInfrastructureFailure({
      outcomes: [
        outcome("a", {
          status: "failed",
          output: {
            text: "",
            artifacts: [],
            tool_calls: 0,
            error: "401 for Authorization: Bearer sk-live-abcdefghijklmnop1234",
          },
        }),
      ],
      judgments: [],
      ...providers,
    });
    expect(failure!.message).not.toContain("sk-live-abcdefghijklmnop1234");
    expect(infrastructureFailureReason(failure!)).not.toMatch(/sk-live-/);
  });
});
