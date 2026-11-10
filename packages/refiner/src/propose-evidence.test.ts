import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSkillDoc, NaiveInContextStrategy } from "@intentsolutions/refiner-core";
import { RefinerStore } from "./store.js";
import { proposeWithEvidence } from "./propose-evidence.js";
import { OpenAICompatCompletionClient, type CompletionClient } from "./propose.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const doc = makeSkillDoc("demo", "# Demo\nDo the thing carefully.\n");
const strategy = new NaiveInContextStrategy();
const proposal =
  '{"rationale":"Improve clarity","ops":[{"kind":"replace","target":"carefully","content":"with care"}]}';
function setup() {
  const root = mkdtempSync(join(tmpdir(), "refiner-usage-"));
  roots.push(root);
  const store = new RefinerStore({ root });
  const records = () =>
    readFileSync(join(root, ".j-rig/refiner/log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; hash: string })
      .map((entry) => ({
        kind: entry.kind,
        value: store.get<Record<string, unknown>>(entry.hash)!,
      }));
  return { store, records };
}
function client(text: string) {
  return new OpenAICompatCompletionClient({
    apiKey: "secret-test-key",
    baseUrl: "https://private.test",
    transport: async () => ({
      status: 200,
      json: {
        model: "concrete",
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 17, completion_tokens: 9 },
      },
    }),
  });
}
const opts = { format: "openai" as const, model: "alias" };

describe("durable proposal accounting", () => {
  it("stores intent before I/O and links measured completion to proposal", async () => {
    const { store, records } = setup();
    const real = client(proposal);
    const observed: CompletionClient = {
      complete: real.complete.bind(real),
      completeWithUsage: async (req) => {
        expect(records()).toHaveLength(1);
        expect(records()[0].value.status).toBe("started");
        return real.completeWithUsage(req);
      },
    };
    const result = await proposeWithEvidence(
      strategy,
      { doc, rollouts: [] },
      observed,
      store,
      opts,
    );
    const receipt = store.get<{ status: string; calls: string[]; proposalHash: string }>(
      result.receiptHash,
    )!;
    expect(receipt.status).toBe("proposed");
    expect(store.get(receipt.proposalHash)).toEqual(result.proposal);
    expect(store.get(receipt.calls[0])).toMatchObject({
      status: "completed",
      requestedModel: "alias",
      measurement: {
        reportedModel: "concrete",
        usage: { promptTokens: 17, completionTokens: 9 },
      },
    });
    const encoded = JSON.stringify(records());
    expect(encoded).not.toContain("secret-test-key");
    expect(encoded).not.toContain("private.test");
    expect(encoded).not.toContain(doc.text);
  });
  it("retains measured usage when proposal parsing fails", async () => {
    const { store, records } = setup();
    await expect(
      proposeWithEvidence(strategy, { doc, rollouts: [] }, client("not JSON"), store, opts),
    ).rejects.toThrow();
    expect(records().find((r) => r.value.status === "completed")?.value).toMatchObject({
      measurement: { usage: { promptTokens: 17, completionTokens: 9 } },
    });
    expect(records().at(-1)?.value).toMatchObject({ status: "failed", proposalHash: null });
  });
  it("retains failed calls as unknown without storing transport errors or retrying", async () => {
    const { store, records } = setup();
    const complete = vi.fn().mockRejectedValue(new Error("secret transport error"));
    await expect(
      proposeWithEvidence(strategy, { doc, rollouts: [] }, { complete }, store, opts),
    ).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(records()[1].value).toMatchObject({ status: "failed", measurement: null });
    expect(JSON.stringify(records())).not.toContain("secret transport error");
  });
  it("never admits a paid call if the initial receipt cannot be stored", async () => {
    const { store } = setup();
    vi.spyOn(store, "put").mockImplementation(() => {
      throw new Error("disk full");
    });
    const complete = vi.fn();
    await expect(
      proposeWithEvidence(strategy, { doc, rollouts: [] }, { complete }, store, opts),
    ).rejects.toThrow("disk full");
    expect(complete).not.toHaveBeenCalled();
  });
  it("leaves durable started evidence if storing a response fails", async () => {
    const { store, records } = setup();
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation((kind, value) => {
      if (kind === "completion-attempt" && (value as { status: string }).status === "completed")
        throw new Error("disk full");
      return put(kind, value);
    });
    await expect(
      proposeWithEvidence(strategy, { doc, rollouts: [] }, client(proposal), store, opts),
    ).rejects.toThrow("disk full");
    const calls = records().filter((r) => r.kind === "completion-attempt");
    expect(calls).toHaveLength(1);
    expect(calls[0].value.status).toBe("started");
  });
  it("records each call from a multi-call strategy separately", async () => {
    const { store, records } = setup();
    await proposeWithEvidence(
      {
        id: strategy.id,
        description: "two calls",
        async propose(ctx) {
          await ctx.model.complete("first prompt");
          return strategy.propose(ctx);
        },
      },
      { doc, rollouts: [] },
      client(proposal),
      store,
      opts,
    );
    const completed = records().filter((r) => r.value.status === "completed");
    expect(completed.map((r) => r.value.sequence)).toEqual([0, 1]);
    expect(completed[0].value.runId).toBe(completed[1].value.runId);
    expect(completed[0].value.promptHash).not.toBe(completed[1].value.promptHash);
  });
  it("distinguishes skills with identical content in successful and failed receipts", async () => {
    const { store, records } = setup();
    const other = makeSkillDoc("other-skill", doc.text);
    expect(other.hash).toBe(doc.hash);
    await proposeWithEvidence(strategy, { doc, rollouts: [] }, client(proposal), store, opts);
    await expect(
      proposeWithEvidence(strategy, { doc: other, rollouts: [] }, client("invalid"), store, opts),
    ).rejects.toThrow();
    const receipts = records().filter(
      (r) => r.kind === "completion-attempt" || r.kind === "proposal-attempt",
    );
    expect(receipts.map((r) => r.value.skillId)).toEqual([
      "demo",
      "demo",
      "demo",
      "other-skill",
      "other-skill",
      "other-skill",
    ]);
  });
  it("keeps missing usage explicit and distinct calls distinct", async () => {
    const { store, records } = setup();
    for (let i = 0; i < 2; i++)
      await proposeWithEvidence(
        strategy,
        { doc, rollouts: [] },
        { complete: async () => proposal },
        store,
        opts,
      );
    const completed = records().filter((r) => r.value.status === "completed");
    expect(completed).toHaveLength(2);
    expect(completed[0].value.runId).not.toBe(completed[1].value.runId);
    expect(completed[0].value).toMatchObject({ measurement: { status: "missing", usage: null } });
  });
});
