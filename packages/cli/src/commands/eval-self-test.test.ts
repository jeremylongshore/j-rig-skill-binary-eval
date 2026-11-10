import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateDeclaredSelfTest } from "./eval-self-test.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eval-self-test-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

const declared = { command: "node self-test.cjs", expect_exit: 0, blocker: true };

describe("declared self-test orchestration", () => {
  it("leaves an undeclared self-test absent even with the opt-in", () => {
    expect(evaluateDeclaredSelfTest(undefined, directory, { runSelfTest: true })).toEqual({
      selfTestJudgment: undefined,
      selfTestCriterion: undefined,
    });
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each([false, true])("never runs a declared command without opt-in (json=%s)", (json) => {
    // There is deliberately no script: accidental execution would produce a failed judgment.
    expect(evaluateDeclaredSelfTest(declared, directory, { json })).toEqual({
      selfTestJudgment: undefined,
      selfTestCriterion: undefined,
    });
    expect(vi.mocked(console.log).mock.calls).toEqual(
      json
        ? []
        : [
            [
              "  Self-test: skill declares a self_test; re-run with --run-self-test to execute it as a deterministic criterion.",
            ],
          ],
    );
  });

  it.each([
    { code: 0, blocker: true, json: false, verdict: "yes" },
    { code: 2, blocker: false, json: false, verdict: "no" },
    { code: 0, blocker: true, json: true, verdict: "yes" },
  ])(
    "runs exactly once and retains the judgment: $verdict, json=$json",
    ({ code, blocker, json, verdict }) => {
      writeFileSync(
        join(directory, "self-test.cjs"),
        [
          'require("node:fs").appendFileSync("executions", "run\\n");',
          `process.exitCode = ${code};`,
        ].join("\n"),
      );
      const result = evaluateDeclaredSelfTest({ ...declared, blocker }, directory, {
        runSelfTest: true,
        json,
      });
      expect(readFileSync(join(directory, "executions"), "utf8")).toBe("run\n");
      expect(result.selfTestJudgment).toMatchObject({
        criterion_id: "self-test",
        verdict,
        confidence: 1,
        method: "deterministic",
        reasoning: `exit ${code} (expected 0)`,
      });
      expect(result.selfTestCriterion).toMatchObject({
        id: "self-test",
        blocker,
        method: "deterministic",
      });
      expect(vi.mocked(console.log).mock.calls).toEqual(
        json
          ? []
          : [[expect.stringContaining(`exit ${code} (expected 0)${blocker ? " (blocker)" : ""}`)]],
      );
    },
  );
});
