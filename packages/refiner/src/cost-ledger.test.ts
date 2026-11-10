import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CostPolicy } from "@intentsolutions/refiner-core";
import { CostLedger } from "./cost-ledger.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const policy = (): CostPolicy => ({
  schema: "refiner-cost-policy/v1",
  scopeId: "test",
  profile: "custom",
  source: "synthetic fixture rates",
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
});
function setup(p = policy()) {
  const dir = mkdtempSync(join(tmpdir(), "refiner-cost-"));
  dirs.push(dir);
  const path = join(dir, "audit", "wave-b-cost-ledger.jsonl");
  return { path, p, ledger: new CostLedger(path, p) };
}
const input = (attemptId = "attempt", fileId = "a") => ({
  attemptId,
  fileId,
  provider: "fixture",
  model: "test",
  phase: "propose",
  outputLimit: 50,
  requestHash: "a".repeat(64),
});
describe("durable cost admission", () => {
  it("holds pending reservations across restarts and quarantines at file admission failure", () => {
    const { path, p, ledger } = setup();
    ledger.reserve(input());
    const recovered = new CostLedger(path, p);
    expect(recovered.snapshot().total).toMatchObject({
      committedMicros: 150,
      knownMicros: 0,
      pendingCalls: 1,
    });
    expect(() => recovered.reserve(input("next"))).toThrow(/admission stopped/);
    expect(new CostLedger(path, p).snapshot().files.a?.quarantined).toBe(true);
  });
  it("records priced failed calls and cumulative acceptance cost", () => {
    const { ledger } = setup();
    const id = ledger.reserve(input());
    ledger.settle({
      callId: id,
      outcome: "failed",
      reportedModel: "test",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    ledger.outcome({ attemptId: "attempt", fileId: "a", decision: "failed" });
    const next = ledger.reserve(input("next"));
    ledger.settle({
      callId: next,
      outcome: "completed",
      reportedModel: "test",
      usage: { inputTokens: 20, outputTokens: 3 },
    });
    ledger.outcome({ attemptId: "next", fileId: "a", decision: "accepted" });
    expect(ledger.snapshot().files.a).toMatchObject({
      knownMicros: 35,
      committedMicros: 35,
      costPerAcceptMicros: 35,
    });
  });
  it.each([null, "unpriced-model"])("does not release unknown cost (%s)", (model) => {
    const { ledger } = setup();
    const id = ledger.reserve(input());
    ledger.settle({
      callId: id,
      outcome: "failed",
      reportedModel: model,
      usage: model ? { inputTokens: 1, outputTokens: 1 } : null,
    });
    expect(ledger.snapshot()).toMatchObject({
      stopped: true,
      total: { committedMicros: 150, unknownCalls: 1 },
    });
    expect(() => ledger.reserve(input("next", "b"))).toThrow(/admission stopped/);
  });
  it("stops the whole wave before a quote crosses 80 percent", () => {
    const { ledger } = setup();
    ledger.reserve(input());
    ledger.reserve(input("second", "b"));
    expect(() => ledger.reserve(input("third", "b"))).toThrow(/admission stopped/);
    expect(ledger.snapshot()).toMatchObject({ stopped: true, total: { committedMicros: 300 } });
  });
  it("retains actual overruns and raises P0", () => {
    const { ledger } = setup();
    const id = ledger.reserve(input());
    ledger.settle({
      callId: id,
      outcome: "completed",
      reportedModel: "test",
      usage: { inputTokens: 400, outputTokens: 1 },
    });
    expect(ledger.snapshot()).toMatchObject({
      p0: true,
      stopped: true,
      total: { knownMicros: 401 },
    });
  });
  it("refuses policy changes, truncated logs, and modified records", () => {
    const { path, p, ledger } = setup();
    expect(() => new CostLedger(path, { ...p, maxFileMicros: 201 })).toThrow(/policy changed/);
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.trimEnd());
    expect(() => ledger.snapshot()).toThrow(/Truncated/);
    writeFileSync(path, text.replace('"scopeId":"test"', '"scopeId":"tamper"'));
    expect(() => ledger.snapshot()).toThrow(/Corrupt/);
  });
  it("fails closed on a competing or crashed writer lock without deleting it", () => {
    const { path, ledger } = setup();
    mkdirSync(`${path}.lock`);
    expect(() => ledger.reserve(input())).toThrow();
    expect(() => ledger.snapshot()).toThrow();
  });
  it("refuses duplicate settlement and outcome without altering the ledger", () => {
    const { path, ledger } = setup();
    const id = ledger.reserve(input());
    const settlement = {
      callId: id,
      outcome: "completed" as const,
      reportedModel: "test",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    ledger.settle(settlement);
    const text = readFileSync(path, "utf8");
    expect(() => ledger.settle(settlement)).toThrow(/duplicate/);
    expect(readFileSync(path, "utf8")).toBe(text);
    const outcome = { attemptId: "attempt", fileId: "a", decision: "accepted" as const };
    ledger.outcome(outcome);
    expect(() => ledger.outcome(outcome)).toThrow(/Duplicate/);
  });
});

it("serializes competing process admission against the same remaining budget", async () => {
  const { path, p } = setup();
  const module = pathToFileURL(resolve("packages/refiner/dist/index.js")).href;
  const script = `const {CostLedger} = await import(process.argv[1]);
    try {
      const ledger = new CostLedger(process.argv[2], JSON.parse(process.argv[3]));
      ledger.reserve(JSON.parse(process.argv[4]));
      process.exitCode = 0;
    } catch { process.exitCode = 3; }`;
  function contender(attempt: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          module,
          path,
          JSON.stringify(p),
          JSON.stringify(input(attempt)),
        ],
        { stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("close", resolve);
    });
  }
  const codes = await Promise.all([contender("one"), contender("two")]);
  expect(codes.sort()).toEqual([0, 3]);
  expect(new CostLedger(path, p).snapshot().total).toMatchObject({
    pendingCalls: 1,
    committedMicros: 150,
  });
});

it("refuses a symlink ledger without reading or modifying its target", () => {
  const { path, p } = setup();
  const target = `${path}.target`;
  const secret = "private target must stay untouched";
  writeFileSync(target, secret);
  rmSync(path);
  symlinkSync(target, path);
  expect(() => new CostLedger(path, p)).toThrow();
  expect(readFileSync(target, "utf8")).toBe(secret);
});
