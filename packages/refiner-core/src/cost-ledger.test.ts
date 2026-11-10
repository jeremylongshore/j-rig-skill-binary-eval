import { expect, it } from "vitest";
import { replayCostLedger, type CostEvent } from "./cost-ledger.js";
import { type CostPolicy } from "./cost-policy.js";
const policy: CostPolicy = {
  schema: "refiner-cost-policy/v1",
  scopeId: "test",
  profile: "custom",
  source: "fixture",
  files: ["a", "b"],
  rates: [
    {
      provider: "fixture",
      model: "test",
      reportedModels: ["test"],
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
};
const header: CostEvent = { kind: "policy", policy };
const reserve: CostEvent = {
  kind: "reserve",
  callId: "call",
  attemptId: "attempt",
  fileId: "a",
  phase: "propose",
  provider: "fixture",
  model: "test",
  outputLimit: 50,
  reservedMicros: 150,
  requestHash: "a".repeat(64),
};
const settle: CostEvent = {
  kind: "settle",
  callId: "call",
  outcome: "completed",
  reportedModel: "test",
  usage: { inputTokens: 10, outputTokens: 2 },
};
const accepted: CostEvent = {
  kind: "outcome",
  attemptId: "attempt",
  fileId: "a",
  decision: "accepted",
};
it("replays an accepted attempt and returns isolated policy and rollups", () => {
  const events = [header, reserve, settle, accepted];
  const result = replayCostLedger(events);
  expect(result.total).toMatchObject({
    knownMicros: 12,
    committedMicros: 12,
    accepted: 1,
    costPerAcceptMicros: 12,
  });
  result.policy.files.push("mutated");
  result.files.a!.knownMicros = 99;
  expect(replayCostLedger(events).total.knownMicros).toBe(12);
  expect(policy.files).toEqual(["a", "b"]);
});
it("preserves pending commitments and unknown settled costs", () => {
  expect(replayCostLedger([header, reserve]).total).toMatchObject({
    pendingCalls: 1,
    committedMicros: 150,
    costPerAcceptMicros: null,
  });
  const result = replayCostLedger([header, reserve, { ...settle, usage: null }]);
  expect(result).toMatchObject({ stopped: true, total: { unknownCalls: 1, committedMicros: 150 } });
  expect(result.files.a?.quarantined).toBe(true);
});
it("retains overrun costs, mean excess and P0", () => {
  const result = replayCostLedger([
    header,
    reserve,
    { ...settle, usage: { inputTokens: 400, outputTokens: 100 } },
  ]);
  expect(result).toMatchObject({
    stopped: true,
    p0: true,
    aboveMeanBudget: true,
    total: { knownMicros: 500 },
  });
});
it.each(["file", "wave"] as const)("replays a durable %s halt", (scope) => {
  const result = replayCostLedger([
    header,
    { kind: "halt", fileId: "a", scope, reason: scope === "file" ? "file-limit" : "wave-stop" },
  ]);
  expect(scope === "file" ? result.files.a?.quarantined : result.stopped).toBe(true);
});
const invalidHistories: unknown[][] = [
  [],
  [reserve],
  [header, header],
  [header, settle],
  [header, reserve, reserve],
  [header, { ...reserve, reservedMicros: 1 }],
  [header, { ...reserve, fileId: "missing" }],
  [header, { ...reserve, model: "unpriced" }],
  [header, reserve, { ...reserve, callId: "other", fileId: "b" }],
  [header, reserve, settle, settle],
  [header, reserve, accepted],
  [header, accepted],
  [header, reserve, settle, { ...accepted, fileId: "b" }],
  [header, reserve, { ...settle, usage: null }, accepted],
  [header, reserve, { ...settle, reportedModel: "unpriced" }, accepted],
  [header, reserve, { ...settle, outcome: "failed" }, accepted],
  [header, reserve, settle, accepted, accepted],
  [header, reserve, settle, accepted, { ...reserve, callId: "next" }],
  [header, { ...accepted, fileId: "missing" }],
];
it.each(invalidHistories.map((events) => ({ events })))(
  "rejects invalid ledger history %#",
  ({ events }) => {
    expect(() => replayCostLedger(events)).toThrow();
  },
);
it("records failure after interruption without claiming accepted cost", () => {
  expect(
    replayCostLedger([header, reserve, { ...accepted, decision: "failed" }]).total,
  ).toMatchObject({ pendingCalls: 1, accepted: 0 });
});
