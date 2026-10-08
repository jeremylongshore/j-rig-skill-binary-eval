import { describe, expect, it } from "vitest";
import { CriterionSchema } from "../schemas/criterion.js";
import { judgeCriteria } from "../judgment/engine.js";
import type { ObservedOutcome } from "../execution/types.js";
import type { Trajectory } from "../execution/trajectory.js";
import {
  isTrajectoryCheck,
  runTrajectoryCheck,
  trajectoryCheckParamIssues,
  type TrajectoryCheckInput,
} from "./trajectory-checks.js";

const SHA = "4480c3f1dd1164a44521007b732fee306b2e3ce5f3c1cb64e2825db7b5d1e231";

// Shape of the recorded write-receipt run (cli __fixtures__/claude-code).
const trajectory: Trajectory = {
  schema: "j-rig/trajectory/v1",
  source: "claude-code",
  steps: [
    { index: 0, tool: "Skill", input_summary: "receipt-writer" },
    { index: 1, tool: "Write", input_summary: "report.md" },
    { index: 2, tool: "Bash", input_summary: "sha256sum report.md > report.md.sha256" },
    { index: 3, tool: "Bash", input_summary: "cat report.md.sha256" },
  ],
  files: [
    { path: "fixture.txt", sha256: "a".repeat(64), size_bytes: 3, change: "unchanged" },
    { path: "gone.txt", sha256: null, size_bytes: 0, change: "deleted" },
    { path: "report.md", sha256: SHA, size_bytes: 11, change: "created" },
    { path: "report.md.sha256", sha256: "b".repeat(64), size_bytes: 77, change: "created" },
  ],
  turns: 4,
  stop: "completed",
};

const input: TrajectoryCheckInput = {
  trajectory,
  artifacts: [
    { filename: "report.md", content: "hello j-rig", type: "text", size_bytes: 11 },
    {
      filename: "report.md.sha256",
      content: `${SHA}  report.md\n`,
      type: "text",
      size_bytes: 77,
    },
  ],
};

const run = (name: Parameters<typeof runTrajectoryCheck>[0], params: Record<string, unknown>) =>
  runTrajectoryCheck(name, input, params);

describe("trajectory checks", () => {
  it("tool_called counts matching calls against min_count", () => {
    expect(run("tool_called", { tool: "Skill", input_contains: "receipt-writer" }).passed).toBe(
      true,
    );
    expect(run("tool_called", { tool: "Bash", min_count: 2 }).passed).toBe(true);
    expect(run("tool_called", { tool: "Bash", min_count: 3 })).toEqual({
      passed: false,
      message: "Bash called 2 time(s); required at least 3",
    });
    expect(run("tool_called", { tool: "bash" }).passed).toBe(false); // exact, case-sensitive
  });

  it("tool_not_called names the offending step", () => {
    expect(run("tool_not_called", { tool: "Edit" }).passed).toBe(true);
    expect(run("tool_not_called", { tool: "Bash", input_contains: "pandoc" }).passed).toBe(true);
    expect(run("tool_not_called", { tool: "Bash", input_contains: "sha256sum" })).toEqual({
      passed: false,
      message: "Bash(…sha256sum…) was called at step 2",
    });
  });

  it("order_before compares FIRST occurrences and fails when either side is missing", () => {
    const write = { tool: "Write" };
    const sum = { tool: "Bash", input_contains: "sha256sum" };
    expect(run("order_before", { first: write, then: sum }).passed).toBe(true);
    expect(run("order_before", { first: sum, then: write }).passed).toBe(false);
    expect(run("order_before", { first: { tool: "Edit" }, then: write })).toEqual({
      passed: false,
      message: "Edit never called",
    });
  });

  it("file_exists by path or pattern, ignoring deleted files, optionally requiring production", () => {
    expect(run("file_exists", { path: "report.md" }).passed).toBe(true);
    expect(run("file_exists", { pattern: "\\.sha256$" }).passed).toBe(true);
    expect(run("file_exists", { path: "gone.txt" }).passed).toBe(false);
    expect(run("file_exists", { path: "fixture.txt" }).passed).toBe(true);
    expect(run("file_exists", { path: "fixture.txt", produced: true })).toEqual({
      passed: false,
      message: '"fixture.txt" exists but the run did not produce it',
    });
  });

  it("file_matches_sha_in verifies the recorded sha256 in a produced text file", () => {
    expect(run("file_matches_sha_in", { path: "report.md", in: "{path}.sha256" })).toEqual({
      passed: true,
      message: "sha256 of report.md recorded in {path}.sha256",
    });
    // Tampered receipt.
    const tampered: TrajectoryCheckInput = {
      ...input,
      artifacts: [{ ...input.artifacts[1]!, content: `${"0".repeat(64)}  report.md\n` }],
    };
    expect(
      runTrajectoryCheck("file_matches_sha_in", tampered, {
        path: "report.md",
        in: "{path}.sha256",
      }).passed,
    ).toBe(false);
    // `in` must be a text file the run produced; a fixture cannot vouch.
    expect(run("file_matches_sha_in", { path: "report.md", in: "fixture.txt" }).message).toMatch(
      /not a text file the run produced/,
    );
    expect(run("file_matches_sha_in", { pattern: "\\.pdf$", in: "x" }).passed).toBe(false);
  });

  it("fails closed without a trajectory, so a text-only provider can never pass vacuously", () => {
    const r = runTrajectoryCheck("tool_not_called", { artifacts: [] }, { tool: "Bash" });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/--execution-provider claude-code/);
  });

  it("refuses a truncated trajectory, so a budget-cut run cannot pass tool_not_called", () => {
    for (const stop of ["max_turns", "timeout", "budget", "error", "no_result"] as const) {
      const r = runTrajectoryCheck(
        "tool_not_called",
        { ...input, trajectory: { ...trajectory, stop } },
        { tool: "Edit" },
      );
      expect(r).toEqual({
        passed: false,
        message: `Check "tool_not_called" refused: the run ended with stop "${stop}", so its trajectory is truncated`,
      });
    }
  });

  it("fails closed on invalid params that bypassed the spec schema", () => {
    const r = run("file_exists", { path: "a", pattern: "b" });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/exactly one of `path` or `pattern`/);
  });

  it("validates params per check", () => {
    expect(isTrajectoryCheck("order_before")).toBe(true);
    expect(isTrajectoryCheck("contains")).toBe(false);
    expect(isTrajectoryCheck("toString")).toBe(false);
    expect(trajectoryCheckParamIssues("tool_called", {})).toEqual([
      expect.stringMatching(/^tool_called: .* at params\.tool$/),
    ]);
    expect(trajectoryCheckParamIssues("tool_called", { tool: "Bash", extra: 1 })).not.toEqual([]);
    expect(trajectoryCheckParamIssues("file_exists", { pattern: "(" })).toEqual([
      "file_exists: `pattern` is not a valid regular expression",
    ]);
    expect(trajectoryCheckParamIssues("file_matches_sha_in", { path: "a" })).not.toEqual([]);
    for (const bad of ["../golden.sha256", "/etc/x", "a/../../b"]) {
      expect(trajectoryCheckParamIssues("file_matches_sha_in", { path: "a", in: bad })).toEqual([
        "file_matches_sha_in: `in` must be a workspace-relative path without `..` at params.in",
      ]);
    }
    expect(
      trajectoryCheckParamIssues("order_before", { first: { tool: "A" }, then: { tool: "B" } }),
    ).toEqual([]);
  });
});

describe("spec schema + judgment engine integration", () => {
  const criterion = (check: string, params: Record<string, unknown>) => ({
    id: "c",
    description: "d",
    method: "deterministic",
    deterministic_check: check,
    deterministic_check_params: params,
  });

  it("rejects a trajectory criterion with bad params at spec load", () => {
    const bad = CriterionSchema.safeParse(criterion("order_before", { first: { tool: "Write" } }));
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(["deterministic_check_params"]);
    expect(CriterionSchema.safeParse(criterion("tool_called", { tool: "Write" })).success).toBe(
      true,
    );
    // Text checks keep their free-form params.
    expect(CriterionSchema.safeParse(criterion("contains", { anything: 1 })).success).toBe(true);
  });

  it("grades trajectory criteria from the outcome, not the text", async () => {
    const outcome: ObservedOutcome = {
      test_case_id: "t",
      prompt: "p",
      output: {
        text: "I never called Bash",
        artifacts: input.artifacts,
        tool_calls: 4,
        trajectory,
      },
      meta: { started_at: "", completed_at: "", duration_ms: 0, timed_out: false },
      status: "completed",
    };
    const criteria = [
      CriterionSchema.parse({ ...criterion("tool_not_called", { tool: "Bash" }), id: "no-bash" }),
      CriterionSchema.parse({
        ...criterion("file_matches_sha_in", { path: "report.md", in: "{path}.sha256" }),
        id: "receipt",
      }),
    ];
    const judge = {
      judge: () => Promise.reject(new Error("deterministic criteria never reach the judge")),
    };
    const results = await judgeCriteria(criteria, outcome, judge as never);
    expect(results.map((r) => [r.criterion_id, r.verdict])).toEqual([
      ["no-bash", "no"],
      ["receipt", "yes"],
    ]);
    expect(results[0]?.reasoning).toBe("Bash was called at step 2");
  });
});
