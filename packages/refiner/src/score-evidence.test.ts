import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapFromItems, makeSkillDoc } from "@intentsolutions/refiner-core";
import { RefinerStore } from "./store.js";
import { createAccountingEvalRunner } from "./score-evidence.js";
import { readEvaluationUsage, score, type EvalInvocation } from "./score.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const doc = makeSkillDoc("demo", "# Demo\nDo work.");
const evalSet = bootstrapFromItems(doc, "synthetic", [
  { id: "case", prompt: "prompt", expectation: "correct answer" },
]);
const invocation: EvalInvocation = {
  doc,
  evalSet,
  skillDir: "/private/source",
  modelTier: "alias",
  provider: "openai",
};
const evidence = {
  schema: "evaluation-usage/v1",
  calls: [
    {
      sequence: 0,
      phase: "execution",
      provider: "openai",
      requestedModel: "alias",
      reportedModel: "actual",
      outcome: "completed",
      usage: { inputTokens: 10, outputTokens: 2 },
    },
  ],
};
const stdout = (value: unknown = evidence) =>
  JSON.stringify({ alias: { cost: { usage_evidence: value } } });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "refiner-score-cost-"));
  roots.push(root);
  const store = new RefinerStore({ root });
  const records = () =>
    store
      .readLog()
      .flatMap((e) => (e.type === "stored" ? [store.get<Record<string, unknown>>(e.hash)!] : []));
  return { store, records };
}

describe("durable evaluation attempts", () => {
  it.each([0, 2, 3])("persists calls before scoring validation at exit %s", async (exitCode) => {
    const { store, records } = setup();
    const inner = {
      run: vi.fn(async () => {
        expect(records()[0].status).toBe("started");
        return { exitCode, stdout: stdout(), stderr: "private error" };
      }),
    };
    const runner = createAccountingEvalRunner(inner, store, { proposalHash: "a".repeat(64) });
    // Successful evaluator exit with no scorecard also fails scoring, after retaining usage.
    await expect(
      score(doc, evalSet, runner, { skillDir: "/private/source", modelTier: "alias" }),
    ).rejects.toThrow();
    expect(records()[1]).toMatchObject({
      status: exitCode === 0 ? "completed" : "failed",
      usage: { status: "reported", evidence },
    });
    expect(JSON.stringify(records())).not.toContain("private error");
    expect(JSON.stringify(records())).not.toContain("/private/source");
    expect(JSON.stringify(records())).not.toContain(doc.text);
    expect(runner.attemptCount).toBe(1);
  });
  it("retains a completed baseline if the next subprocess fails", async () => {
    const { store, records } = setup();
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: stdout(), stderr: "" })
      .mockRejectedValueOnce(new Error("secret"));
    const runner = createAccountingEvalRunner({ run }, store);
    await runner.run(invocation);
    await expect(runner.run(invocation)).rejects.toThrow();
    expect(records()).toHaveLength(4);
    expect(records()[1]).toMatchObject({ runId: runner.runId, sequence: 0, usage: { evidence } });
    expect(records()[3]).toMatchObject({
      runId: runner.runId,
      sequence: 1,
      status: "failed",
      usage: { status: "missing", evidence: null },
    });
    expect(JSON.stringify(records())).not.toContain("secret");
  });
  it("does not call the evaluator if initial receipt storage fails", async () => {
    const { store } = setup();
    vi.spyOn(store, "put").mockImplementation(() => {
      throw new Error("disk full");
    });
    const run = vi.fn();
    await expect(createAccountingEvalRunner({ run }, store).run(invocation)).rejects.toThrow(
      "disk full",
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("leaves a started receipt if final storage fails", async () => {
    const { store, records } = setup();
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation((kind, value) => {
      if ((value as { status: string }).status !== "started") throw new Error("disk full");
      return put(kind, value);
    });
    await expect(
      createAccountingEvalRunner(
        { run: async () => ({ exitCode: 0, stdout: stdout(), stderr: "" }) },
        store,
      ).run(invocation),
    ).rejects.toThrow("disk full");
    expect(records()).toHaveLength(1);
    expect(records()[0].status).toBe("started");
  });
  it("does not admit tampered input", async () => {
    const { store } = setup();
    const run = vi.fn();
    await expect(
      createAccountingEvalRunner({ run }, store).run({
        ...invocation,
        doc: { ...doc, text: "changed" },
      }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(store.readLog()).toEqual([]);
  });
});

describe("usage across the evaluator JSON boundary", () => {
  it.each([
    "",
    "not JSON",
    JSON.stringify({ alias: {} }),
    JSON.stringify({ alias: { cost: null } }),
    JSON.stringify({ alias: { cost: {} } }),
  ])("does not invent usage from legacy or missing data: %s", (text) => {
    expect(readEvaluationUsage(text, "alias")).toEqual({ status: "missing", evidence: null });
  });
  it.each([
    JSON.stringify({ a: {}, b: {} }),
    JSON.stringify({ alias: 2 }),
    JSON.stringify({ alias: { cost: 2 } }),
    stdout({ ...evidence, calls: [{ ...evidence.calls[0], sequence: 1 }] }),
    stdout({ ...evidence, secret: "bad" }),
  ])("rejects invalid or ambiguous cost evidence: %s", (text) => {
    expect(readEvaluationUsage(text, "alias")).toEqual({ status: "invalid", evidence: null });
  });
  it("preserves explicit null usage and supports the single resolved-model result", () => {
    const value = { ...evidence, calls: [{ ...evidence.calls[0], usage: null }] };
    expect(
      readEvaluationUsage(JSON.stringify({ actual: { cost: { usage_evidence: value } } }), "alias"),
    ).toEqual({ status: "reported", evidence: value });
  });
});
