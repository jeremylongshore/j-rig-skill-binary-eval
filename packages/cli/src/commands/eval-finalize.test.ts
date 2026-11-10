import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, getOrCreateSkillVersion, createRun } from "@j-rig/db";
import { composeStatement } from "@j-rig/core";
import { createHash } from "node:crypto";
import { RunBudget } from "../providers/budget.js";
import { finalizeEvaluation } from "./eval-finalize.js";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jrig-finalize-"));
  const database = createDatabase(":memory:");
  const input: Parameters<typeof finalizeEvaluation>[0] = {
    models: ["first", "second"],
    allResults: { first: { verdict: "pass" } },
    budgetStopSeen: false,
    runBudget: new RunBudget({}, {}),
    opts: { json: true, db: ":memory:" },
    bundleRows: [],
    bundleRunIds: [],
    database,
    absDir: join(root, "skill"),
    skillSnapshotSha: "sha256:fixture",
    spec: { spec_version: "1.0" },
    infrastructureFailureSeen: false,
    retainedRollouts: [],
    startTime: Date.now(),
  };
  return {
    root,
    input,
    dispose() {
      database.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("fills only unstarted models, shares the final budget summary, and gives budget stops precedence", () => {
  const f = fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    f.input.budgetStopSeen = true;
    f.input.infrastructureFailureSeen = true;
    f.input.runBudget = new RunBudget({ max_calls: 1 }, { max_calls: "run" });
    process.exitCode = 0;
    finalizeEvaluation(f.input);
    const results = JSON.parse(log.mock.calls[0]![0] as string);
    expect(results.first.verdict).toBe("pass");
    expect(results.second).toMatchObject({ model: "second", skipped: "budget_exhausted" });
    expect(results.first.run_budget).toEqual(results.second.run_budget);
    expect(results.first.run_budget.limits).toEqual({ max_calls: 1 });
    expect(process.exitCode).toBe(3);
  } finally {
    f.dispose();
  }
});

it.each([
  [false, false, 2, "completed", 0],
  [true, false, 2, "incomplete", 2],
  [false, true, 2, "incomplete", 3],
  [false, false, 1, "incomplete", 0],
] as const)(
  "exports completion from failure=%s budget=%s retained=%s",
  (failure, stopped, count, status, code) => {
    const f = fixture();
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      f.input.infrastructureFailureSeen = failure;
      f.input.budgetStopSeen = stopped;
      f.input.opts.rolloutFile = join(f.root, "rollouts.json");
      f.input.retainedRollouts = Array.from({ length: count }, (_, index) => ({
        runId: index + 1,
        model: f.input.models[index]!,
        provider: "stub",
        groundTruth: false,
        status: "completed",
        outcomes: [],
      }));
      process.exitCode = 0;
      finalizeEvaluation(f.input);
      expect(JSON.parse(readFileSync(f.input.opts.rolloutFile, "utf8"))).toEqual({
        schema: "j-rig/rollouts/v1",
        skillId: "skill",
        skillHash: "fixture",
        spec: f.input.spec,
        status,
        runs: f.input.retainedRollouts,
      });
      expect(process.exitCode).toBe(code);
    } finally {
      f.dispose();
    }
  },
);

it("propagates export failure before final output or terminal exit assignment", () => {
  const f = fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    f.input.opts.rolloutFile = join(f.root, "existing.json");
    writeFileSync(f.input.opts.rolloutFile, "preserve me");
    f.input.infrastructureFailureSeen = true;
    process.exitCode = 0;
    expect(() => finalizeEvaluation(f.input)).toThrow();
    expect(readFileSync(f.input.opts.rolloutFile, "utf8")).toBe("preserve me");
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  } finally {
    f.dispose();
  }
});

it.each([1, 2])("links the exact written bundle bytes to every run (%s rows)", (count) => {
  const f = fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    f.input.opts.json = false;
    f.input.runBudget = new RunBudget({ max_calls: 10 }, { max_calls: "run" });
    f.input.opts.emitBundle = join(f.root, "bundle.json");
    const version = getOrCreateSkillVersion(f.input.database, "skill", "1.0.0", "fixture");
    f.input.bundleRunIds = Array.from({ length: count }, () =>
      createRun(f.input.database, version, "full", "model"),
    );
    f.input.bundleRows = Array.from({ length: count }, (_, i) =>
      composeStatement({
        gateId: `j-rig:server:MM-${i}`,
        gateDecision: "pass",
        gateName: "test",
        gateVersion: "1.0.0",
        gateReasons: ["passed"],
        coverage: { dimensionsEvaluated: ["test"], dimensionsSkipped: [] },
        policyRef: `sha256:${"a".repeat(64)}:fixture.json`,
        policyHash: "sha256:" + "a".repeat(64),
        inputHash: "sha256:" + "b".repeat(64),
        runner: "fixture@1.0.0",
        commitSha: "abc1234",
      }),
    );
    finalizeEvaluation(f.input);
    const bytes = readFileSync(f.input.opts.emitBundle);
    expect(JSON.parse(bytes.toString())).toEqual(f.input.bundleRows);
    const artifacts = f.input.database.sqlite
      .prepare(
        "SELECT run_id, sha256, size_bytes FROM artifacts WHERE artifact_type = 'evidence-bundle'",
      )
      .all();
    expect(artifacts).toEqual(
      f.input.bundleRunIds.map((run_id) => ({
        run_id,
        size_bytes: bytes.byteLength,
        sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      })),
    );
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("Budget:"),
      expect.stringContaining(`(${count} gate-result/v1 row`),
      expect.stringContaining("Duration:"),
    ]);
  } finally {
    f.dispose();
  }
});
