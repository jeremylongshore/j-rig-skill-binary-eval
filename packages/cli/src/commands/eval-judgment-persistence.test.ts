import { afterEach, expect, it, vi } from "vitest";
import * as core from "@j-rig/core";
import * as db from "@j-rig/db";
import { persistModelJudgments } from "./eval-judgment-persistence.js";

const databases: db.JRigDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.sqlite.close();
});

function fixture() {
  const database = db.createDatabase(":memory:");
  databases.push(database);
  const version = db.getOrCreateSkillVersion(database, "fixture", "1", "fixture skill");
  const runId = db.createRun(database, version);
  db.transitionRun(database, runId, "running");
  const judgment: core.JudgmentResult = {
    criterion_id: "self-test",
    verdict: "no",
    confidence: 1,
    reasoning: "exit 1",
    method: "deterministic",
  };
  const input: Parameters<typeof persistModelJudgments>[0] = {
    database,
    runId,
    allJudgments: [],
    selfTestJudgment: judgment,
    selfTestCriterion: core.buildSelfTestCriterion({
      command: "node self-test.cjs",
      expect_exit: 0,
      blocker: true,
    }),
    correlation: { evalRunId: "0192cae6-0002-7000-8000-000000000000" },
    opts: { json: true },
    spec: { criteria: [] },
  };
  return input;
}

it.each(["yes", "no"] as const)(
  "appends and emits self-test %s before storing a real SQLite tally",
  (verdict) => {
    const input = fixture();
    input.selfTestJudgment!.verdict = verdict;
    const order: string[] = [];
    vi.spyOn(core, "emitRuntimeCriterionEvaluated").mockImplementation((correlation, event) => {
      order.push("event");
      expect(input.allJudgments).toEqual([input.selfTestJudgment]);
      expect(correlation).toBe(input.correlation);
      expect(event).toEqual({
        matcherClass: "deterministic",
        outcome: verdict === "yes" ? core.CriterionOutcome.PASS : core.CriterionOutcome.FAIL,
      });
      expect(input.database.sqlite.prepare("SELECT * FROM criterion_results").all()).toEqual([]);
    });
    const storeRows = db.storeCriterionResults;
    vi.spyOn(db, "storeCriterionResults").mockImplementation((...args) => {
      order.push("rows");
      return storeRows(...args);
    });
    const storeSummary = db.storeRunSummary;
    vi.spyOn(db, "storeRunSummary").mockImplementation((...args) => {
      order.push("summary");
      return storeSummary(...args);
    });
    const result = persistModelJudgments(input);
    expect(order).toEqual(["event", "rows", "summary"]);
    expect(result.selfTestFailed).toBe(verdict === "no");
    expect(result.scoringCriteria).toEqual([input.selfTestCriterion]);
    expect(
      input.database.sqlite
        .prepare("SELECT total, passed, errors, warnings FROM run_summaries")
        .get(),
    ).toEqual({
      total: 1,
      passed: verdict === "yes" ? 1 : 0,
      errors: verdict === "no" ? 1 : 0,
      warnings: 0,
    });
    expect(input.database.sqlite.prepare("SELECT status FROM runs").get()).toEqual({
      status: "running",
    });
  },
);

it.each(["event", "rows", "summary"] as const)(
  "propagates %s exceptions without returning a success flag or completing the run",
  (site) => {
    const input = fixture();
    const failure = new Error(`${site} unavailable`);
    const event = vi.spyOn(core, "emitRuntimeCriterionEvaluated").mockImplementation(() => {});
    const rows = vi.spyOn(db, "storeCriterionResults");
    const summary = vi.spyOn(db, "storeRunSummary");
    if (site === "event")
      event.mockImplementation(() => {
        throw failure;
      });
    if (site === "rows")
      rows.mockImplementation(() => {
        throw failure;
      });
    if (site === "summary")
      summary.mockImplementation(() => {
        throw failure;
      });
    expect(() => persistModelJudgments(input)).toThrow(failure);
    expect(input.allJudgments).toEqual([input.selfTestJudgment]);
    expect(rows).toHaveBeenCalledTimes(site === "event" ? 0 : 1);
    expect(summary).toHaveBeenCalledTimes(site === "summary" ? 1 : 0);
    expect(input.database.sqlite.prepare("SELECT status FROM runs").get()).toEqual({
      status: "running",
    });
  },
);

it("preserves unsureness, truncated diagnostics, and criterion-list identity without a self-test", () => {
  const input = fixture();
  delete input.selfTestJudgment;
  delete input.selfTestCriterion;
  input.opts.json = false;
  input.allJudgments = [
    { criterion_id: "yes", verdict: "yes", confidence: 1, reasoning: "passed", method: "judge" },
    {
      criterion_id: "maybe",
      verdict: "unsure",
      confidence: 0.5,
      reasoning: "x".repeat(90),
      method: "judge",
    },
    { criterion_id: "no", verdict: "no", confidence: 1, reasoning: "failed", method: "judge" },
  ];
  const event = vi.spyOn(core, "emitRuntimeCriterionEvaluated");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = persistModelJudgments(input);
  expect(result).toEqual({ scoringCriteria: input.spec.criteria, selfTestFailed: false });
  expect(result.scoringCriteria).toBe(input.spec.criteria);
  expect(event).not.toHaveBeenCalled();
  expect(log.mock.calls.flat().join("\n")).toContain("x".repeat(80));
  expect(log.mock.calls.flat().join("\n")).not.toContain("x".repeat(81));
  expect(
    input.database.sqlite
      .prepare("SELECT total, passed, errors, warnings FROM run_summaries")
      .get(),
  ).toEqual({ total: 3, passed: 1, errors: 1, warnings: 1 });
});
