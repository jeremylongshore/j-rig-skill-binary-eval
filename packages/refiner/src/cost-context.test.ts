import { it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CostPolicy } from "@intentsolutions/refiner-core";
import { costSessionFromOptions, openCostSession, recordCostOutcome } from "./cost-context.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cost-context-"));
  dirs.push(root);
  const policy: CostPolicy = {
    schema: "refiner-cost-policy/v1",
    profile: "custom",
    scopeId: "fixture",
    source: "synthetic",
    files: ["a"],
    rates: [
      {
        provider: "fixture",
        model: "fixture",
        reportedModels: ["fixture"],
        format: "openai",
        maxInputTokens: 100,
        maxOutputTokens: 10,
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
    maxFileMicros: 500,
    maxTotalMicros: 1000,
    meanFileBudgetMicros: 20,
    stopBasisPoints: 8000,
  };
  const policyPath = join(root, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  return { policyPath, ledgerPath: join(root, "ledger.jsonl"), fileId: "a", attemptId: "first" };
}
it("requires explicit complete context and canonical file identity", () => {
  expect(costSessionFromOptions({})).toBeUndefined();
  expect(() => costSessionFromOptions({ costFileId: "a" })).toThrow(/require/);
  const context = fixture();
  expect(() => costSessionFromOptions({ costPolicy: context.policyPath })).toThrow(/requires/);
  expect(() => openCostSession({ ...context, policyPath: "relative" })).toThrow(/absolute/);
  expect(() => openCostSession({ ...context, fileId: "missing" })).toThrow(/identity/);
  expect(() => openCostSession({ ...context, arbitrary: true })).toThrow();
  const session = costSessionFromOptions({
    costPolicy: context.policyPath,
    costLedger: context.ledgerPath,
    costFileId: "a",
  });
  expect(session?.context.fileId).toBe("a");
});
it("freezes cumulative file/accept rollups at the outcome boundary", () => {
  const context = fixture();
  const first = openCostSession(context);
  const reserve = {
    attemptId: "first",
    fileId: "a",
    provider: "fixture",
    model: "fixture",
    phase: "propose",
    outputLimit: 10,
    requestHash: "a".repeat(64),
  };
  const id = first.ledger.reserve(reserve);
  first.ledger.settle({
    callId: id,
    reportedModel: "fixture",
    outcome: "failed",
    usage: { inputTokens: 10, outputTokens: 1 },
  });
  const failed = recordCostOutcome(first, "failed")!;
  expect(failed).toMatchObject({
    calls: 1,
    knownMicros: 11,
    unknownCalls: 0,
    file: { accepted: 0, costPerAcceptMicros: null },
  });
  const second = openCostSession({ ...context, attemptId: "second" });
  const next = second.ledger.reserve({ ...reserve, attemptId: "second" });
  second.ledger.settle({
    callId: next,
    reportedModel: "fixture",
    outcome: "completed",
    usage: { inputTokens: 20, outputTokens: 2 },
  });
  const accepted = recordCostOutcome(second, "accepted")!;
  expect(accepted).toMatchObject({
    knownMicros: 22,
    inputTokens: 20,
    outputTokens: 2,
    meanKnownMicros: 33,
    meanComplete: true,
    aboveMeanBudget: true,
    file: { knownMicros: 33, accepted: 1, costPerAcceptMicros: 33 },
  });
  expect(failed.file.knownMicros).toBe(11);
  expect(recordCostOutcome(second, "accepted")).toBeUndefined();
});
it("keeps unknown pricing explicit in outcome reports", () => {
  const session = openCostSession(fixture());
  const id = session.ledger.reserve({
    attemptId: "first",
    fileId: "a",
    provider: "fixture",
    model: "fixture",
    phase: "execution",
    outputLimit: 10,
    requestHash: "a".repeat(64),
  });
  session.ledger.settle({ callId: id, reportedModel: null, outcome: "interrupted", usage: null });
  expect(recordCostOutcome(session, "failed")).toMatchObject({
    knownMicros: 0,
    unknownCalls: 1,
    meanComplete: false,
    stopped: true,
    file: { committedMicros: 110, quarantined: true },
  });
  expect(recordCostOutcome(undefined, "failed")).toBeUndefined();
});
