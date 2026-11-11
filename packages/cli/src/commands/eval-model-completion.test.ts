import { afterEach, expect, it, vi } from "vitest";
import * as core from "@j-rig/core";
import { createDatabase, createRun, getOrCreateSkillVersion, transitionRun } from "@j-rig/db";
import {
  recordEvaluatedModelCompletion,
  type EvaluatedModelCompletionInput,
} from "./eval-model-completion.js";

const HASH = `sha256:${"a".repeat(64)}`;
const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.sqlite.close();
});

function fixture(): EvaluatedModelCompletionInput {
  const database = createDatabase(":memory:");
  databases.push(database);
  const version = getOrCreateSkillVersion(database, "fixture", "1.0.0", "fixture skill");
  const runId = createRun(database, version, "full", "model");
  transitionRun(database, runId, "running");
  const score = {
    total_criteria: 1,
    passed: 1,
    failed: 0,
    unsure: 0,
    blocker_failures: 0,
    sacred_regressions: 0,
    pass_rate: 1,
    unstable_blocker_failures: 0,
  };
  const correlation = { evalRunId: "0192cae6-0002-7000-8000-000000000000" };
  return {
    database,
    runId,
    correlation,
    opts: { json: true, emitBundle: "bundle.jsonl", rolloutFile: "rollout.json" },
    gateDecisionValue: core.GateDecision.PASS,
    gateId: "j-rig:local:fixture.model",
    model: "model",
    infraFailure: null,
    infraFailureReason: null,
    promotionEvidence: core.buildSkillPromotionEvidence({
      evalRunId: correlation.evalRunId,
      storageRunId: runId,
      skill: { name: "fixture", version: "1.0.0", snapshotSha256: HASH },
      evalSpec: { id: "j-rig:skill-profile:fixture", version: "1.0", profileSha256: HASH },
      selectedGrader: {
        graderId: "j-rig-binary-criteria",
        graderVersion: "0.2.0",
        graderSnapshotSha256: HASH,
      },
      score,
      minBlockerAgreement: null,
      regressions: [],
      regressionEnabled: true,
      regressionBaselineSha256: HASH,
      baselineEnabled: false,
      baselineComparisons: [],
      isObsolete: false,
      rolloutDecision: "ship",
    }),
    report: {
      skill_name: "fixture",
      timestamp: "2026-10-01T00:00:00.000Z",
      decision: "ship",
      score,
      regressions: [],
      baseline: [],
      blockers: [],
      warnings: [],
      reasoning: "all criteria met",
    },
    triggerEvidence: {
      schema: "jrig-trigger-evidence/v1",
      status: "not_applicable",
      sha256: HASH,
      metrics: core.computeMetrics([]),
      cases: [],
    },
    allJudgments: [],
    scoringCriteria: [],
    spec: {},
    judgeSamples: undefined,
    scoreCard: score,
    ranRegression: true,
    ranBaseline: false,
    specContentHash: HASH,
    skillSnapshotSha: HASH,
    modelStart: Date.parse("2026-10-01T00:00:00.000Z"),
    jrigVersion: "0.5.1",
    commit: { sha: "b".repeat(40), source: "git" },
    executionMetadata: {},
    providers: { providerName: "stub", real: false },
    toolReceipts: [],
    headroom: null,
    batchLineage: {},
    bundleRows: [],
    bundleRunIds: [],
    retainedRollouts: [],
    outcomes: [
      {
        test_case_id: "case-1",
        prompt: "original prompt",
        output: { text: "original response", artifacts: [], tool_calls: 0 },
        meta: {
          started_at: "2026-10-01T00:00:00.000Z",
          completed_at: "2026-10-01T00:00:01.000Z",
          duration_ms: 1000,
          timed_out: false,
        },
        status: "completed",
      },
    ],
    subscriptionExecution: false,
  };
}

function state(input: EvaluatedModelCompletionInput) {
  return input.database.sqlite
    .prepare("SELECT status, error_message FROM runs WHERE id = ?")
    .get(input.runId);
}

it("emits before evidence, prints before retention, and transitions only after accumulation", () => {
  const input = fixture();
  input.opts.json = false;
  input.report.blockers = ["blocker"];
  input.report.warnings = ["warning"];
  const order: string[] = [];
  const event = vi.spyOn(core, "emitGateDecisionEmitted").mockImplementation(() => {
    order.push("event");
  });
  vi.spyOn(input.bundleRows, "push").mockImplementation((row) => {
    order.push("statement");
    expect(state(input)).toMatchObject({ status: "running" });
    return Array.prototype.push.call(input.bundleRows, row);
  });
  vi.spyOn(input.bundleRunIds, "push").mockImplementation((id) => {
    order.push("run-id");
    return Array.prototype.push.call(input.bundleRunIds, id);
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {
    order.push("output");
  });
  vi.spyOn(input.retainedRollouts, "push").mockImplementation((row) => {
    order.push("rollout");
    expect(state(input)).toMatchObject({ status: "running" });
    return Array.prototype.push.call(input.retainedRollouts, row);
  });
  recordEvaluatedModelCompletion(input);
  expect(order).toEqual([
    "event",
    "statement",
    "run-id",
    "output",
    "output",
    "output",
    "output",
    "rollout",
  ]);
  expect(event).toHaveBeenCalledWith(input.correlation, {
    gateName: "j-rig-rollout-gate",
    decision: input.gateDecisionValue,
    policyRef: HASH,
  });
  expect(log.mock.calls.flat().join("\n")).toContain("blocker");
  expect(input.bundleRunIds).toEqual([input.runId]);
  expect(input.retainedRollouts).toEqual([
    {
      runId: input.runId,
      model: "model",
      provider: "stub",
      groundTruth: false,
      status: "completed",
      outcomes: [
        {
          id: "case-1",
          prompt: "original prompt",
          output: "original response",
          status: "completed",
        },
      ],
    },
  ]);
  expect(input.bundleRows[0]?.predicate.gate_decision).toBe("pass");
  expect(state(input)).toMatchObject({ status: "completed", error_message: null });
});

it("rejects invalid evidence after emission without partial accumulation or terminal state", () => {
  const input = fixture();
  input.gateId = "invalid subject";
  input.opts.json = false;
  const event = vi.spyOn(core, "emitGateDecisionEmitted").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(() => recordEvaluatedModelCompletion(input)).toThrow(
    /composeStatement: validation failed/,
  );
  expect(event).toHaveBeenCalledOnce();
  expect(log).not.toHaveBeenCalled();
  expect(input.bundleRows).toEqual([]);
  expect(input.bundleRunIds).toEqual([]);
  expect(input.retainedRollouts).toEqual([]);
  expect(state(input)).toMatchObject({ status: "running", error_message: null });
});

it("preserves opt-out and JSON silence without validating unused statement fields", () => {
  const input = fixture();
  input.opts = { json: true };
  input.gateId = "invalid subject";
  input.gateDecisionValue = core.GateDecision.FAIL;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  recordEvaluatedModelCompletion(input);
  expect(log).not.toHaveBeenCalled();
  expect(input.bundleRows).toEqual([]);
  expect(input.bundleRunIds).toEqual([]);
  expect(input.retainedRollouts).toEqual([]);
  expect(state(input)).toMatchObject({ status: "completed" });
});

it.each([true, false])(
  "retains infrastructure failure and subscription attribution with JSON=%s",
  (json) => {
    const input = fixture();
    input.opts.json = json;
    input.subscriptionExecution = true;
    input.infraFailure = {
      type: "provider_failure",
      phase: "execution",
      provider: "stub",
      category: "network_timeout",
      retryable: true,
      affected: 1,
      total: 1,
      message: "provider timed out",
    };
    input.infraFailureReason = "provider timed out";
    input.gateDecisionValue = core.GateDecision.ERROR;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    recordEvaluatedModelCompletion(input);
    expect(state(input)).toEqual({
      status: "failed",
      error_message: JSON.stringify(input.infraFailure),
    });
    expect(input.bundleRows[0]?.predicate.gate_decision).toBe("error");
    expect(input.retainedRollouts[0]).toMatchObject({
      provider: "claude-code",
      status: "failed",
      groundTruth: false,
    });
    expect(log.mock.calls.length > 0).toBe(!json);
  },
);
