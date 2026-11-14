import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCostSession } from "@intentsolutions/refiner";
import type { CostPolicy } from "@intentsolutions/refiner-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunBudget } from "../providers/budget.js";
import { EvalCostMeter } from "../providers/cost-tracking.js";
import { resolvePhaseBudgetStop } from "./eval-budget-phase.js";
import type { EvalInfrastructureFailure } from "./eval-infrastructure-failure.js";

type Input = Parameters<typeof resolvePhaseBudgetStop>[0];
const directories: string[] = [];
const failure: EvalInfrastructureFailure = {
  type: "provider_failure",
  phase: "judge",
  provider: "fixture",
  category: "unknown",
  retryable: false,
  affected: 1,
  total: 1,
  message: "local fixture failure",
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function input(limited = false): Input {
  const runBudget = new RunBudget(
    limited ? { max_calls: 0 } : {},
    { max_calls: "run" },
    () => 5000,
  );
  const meter = new EvalCostMeter();
  meter.phase = "judge";
  runBudget.attach(meter, "fixture-model");
  return { runBudget, failure: null, model: "fixture-model", modelStart: 1000 };
}

function session(overrides: Partial<CostPolicy> = {}): NonNullable<Input["costSession"]> {
  const directory = mkdtempSync(join(tmpdir(), "eval-phase-budget-"));
  directories.push(directory);
  const policy: CostPolicy = {
    schema: "refiner-cost-policy/v1",
    scopeId: "phase-fixture",
    profile: "custom",
    source: "synthetic local test rates",
    files: ["skill-a", "skill-b"],
    rates: [
      {
        provider: "fixture",
        model: "fixture-model",
        reportedModels: ["fixture-model"],
        format: "openai",
        maxInputTokens: 100,
        maxOutputTokens: 50,
        protocolOverheadTokens: 0,
        microsPerMillionTokens: {
          input: 1000000,
          output: 1000000,
          cacheRead: 1000000,
          cacheWrite: 1000000,
          cacheWrite5m: 1000000,
          cacheWrite1h: 1000000,
        },
      },
    ],
    maxFileMicros: 200,
    maxTotalMicros: 400,
    meanFileBudgetMicros: 100,
    stopBasisPoints: 8000,
    ...overrides,
  };
  const policyPath = join(directory, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  return openCostSession({
    policyPath,
    ledgerPath: join(directory, "ledger.jsonl"),
    fileId: "skill-a",
    attemptId: "phase-attempt",
  });
}

function reservation() {
  return {
    attemptId: "phase-attempt",
    fileId: "skill-a",
    provider: "fixture",
    model: "fixture-model",
    phase: "judge",
    outputLimit: 50,
    requestHash: "a".repeat(64),
  };
}

describe("eval phase budget decisions", () => {
  it("checks a healthy unlatched run exactly once and keeps it running", () => {
    const state = input();
    const check = vi.spyOn(state.runBudget, "check");
    expect(resolvePhaseBudgetStop(state)).toBeNull();
    expect(check).toHaveBeenCalledExactlyOnceWith();
    expect(state.runBudget.stop).toBeNull();
  });

  it("returns the actual newly latched run budget stop", () => {
    const state = input(true);
    const check = vi.spyOn(state.runBudget, "check");
    const stop = resolvePhaseBudgetStop(state);
    expect(check).toHaveBeenCalledExactlyOnceWith();
    expect(stop).toBe(state.runBudget.stop);
    expect(stop).toMatchObject({
      limit: "max_calls",
      max: 0,
      observed: 0,
      source: "run",
      phase: "judge",
      model: "fixture-model",
    });
  });

  it("retains an existing stop without checking again, even with a current failure", () => {
    const state = input(true);
    const stop = state.runBudget.check();
    const check = vi.spyOn(state.runBudget, "check");
    expect(resolvePhaseBudgetStop({ ...state, failure })).toBe(stop);
    expect(stop).not.toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("does not turn an infrastructure failure into a newly evaluated budget stop", () => {
    const state = input(true);
    const check = vi.spyOn(state.runBudget, "check");
    expect(resolvePhaseBudgetStop({ ...state, failure })).toBeNull();
    expect(check).not.toHaveBeenCalled();
    expect(state.runBudget.stop).toBeNull();
  });

  it("provider failure suppresses both a prior run stop and refused shared admission", () => {
    const state = input(true);
    state.runBudget.check();
    const costSession = session({ maxFileTokens: 0 });
    expect(() => costSession.ledger.reserve(reservation())).toThrow("Cost admission stopped");
    costSession.refused = { phase: "judge" };
    costSession.providerFailed = true;
    const snapshot = vi.spyOn(costSession.ledger, "snapshot");
    const check = vi.spyOn(state.runBudget, "check");
    expect(resolvePhaseBudgetStop({ ...state, costSession })).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it.each([
    ["maxFileTokens", 0, "max_tokens", 0, "file-tokens"],
    ["maxTotalTokens", 0, "max_tokens", 0, "wave-tokens"],
    ["maxFileAttempts", 0, "max_calls", 0, "file-attempts"],
    ["maxAttempts", 0, "max_calls", 0, "wave-attempts"],
    ["maxFileMicros", 100, "max_usd", 0.0001, "file-limit"],
    ["maxTotalMicros", 100, "max_usd", 0.00008, "wave-stop"],
  ] as const)("attributes actual %s refusal with correct units", (key, cap, limit, max, reason) => {
    vi.spyOn(Date, "now").mockReturnValue(5000);
    const state = input(true);
    state.runBudget.check();
    const check = vi.spyOn(state.runBudget, "check");
    const costSession = session({ [key]: cap });
    expect(() => costSession.ledger.reserve(reservation())).toThrow("Cost admission stopped");
    expect(costSession.ledger.snapshot().lastHalt?.reason).toBe(reason);
    costSession.refused = { phase: "execution" };
    expect(resolvePhaseBudgetStop({ ...state, costSession })).toEqual({
      limit,
      max,
      observed: 0,
      source: "cost-policy",
      phase: "execution",
      model: "fixture-model",
      elapsed_ms: 4000,
      reason: "Shared cost admission refused; inspect the pinned ledger",
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("retains committed token spend in a file refusal", () => {
    const costSession = session({ maxFileTokens: 150 });
    costSession.ledger.reserve(reservation());
    expect(() => costSession.ledger.reserve(reservation())).toThrow("Cost admission stopped");
    costSession.refused = { phase: "judge" };
    expect(resolvePhaseBudgetStop({ ...input(), costSession })).toMatchObject({
      limit: "max_tokens",
      max: 150,
      observed: 150,
      source: "cost-policy",
      phase: "judge",
    });
  });

  it("reports unknown settled USD as null rather than zero", () => {
    const costSession = session();
    const callId = costSession.ledger.reserve(reservation());
    costSession.ledger.settle({ callId, outcome: "failed", reportedModel: null, usage: null });
    expect(() => costSession.ledger.reserve(reservation())).toThrow("Cost admission stopped");
    costSession.refused = { phase: "judge" };
    expect(resolvePhaseBudgetStop({ ...input(), costSession })).toMatchObject({
      limit: "max_usd",
      max: 0.00032,
      observed: null,
      source: "cost-policy",
    });
  });
});
