import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { createCompletionClient, createCompletionFetchTransport } from "./propose.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type CostPolicy } from "@intentsolutions/refiner-core";
import { CostLedger } from "./cost-ledger.js";
import { createCostTransport } from "./cost-transport.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(format: "anthropic" | "openai" = "openai") {
  const dir = mkdtempSync(join(tmpdir(), "cost-wire-"));
  dirs.push(dir);
  const policy: CostPolicy = {
    schema: "refiner-cost-policy/v1",
    scopeId: "fixture",
    profile: "custom",
    source: "synthetic",
    files: ["skill"],
    rates: [
      {
        provider: "fixture",
        model: "test",
        reportedModels: ["test"],
        format,
        maxInputTokens: 1000,
        maxOutputTokens: 100,
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
    maxFileMicros: 1100,
    maxTotalMicros: 2000,
    meanFileBudgetMicros: 1000,
    stopBasisPoints: 8000,
  };
  return new CostLedger(join(dir, "cost.jsonl"), policy);
}
const context = {
  fileId: "skill",
  attemptId: "attempt",
  provider: "fixture",
  format: "openai" as const,
  phase: "propose",
};
const request = () => ({
  body: { model: "test", messages: [{ role: "user", content: "hello" }], max_tokens: 100 },
});
it("durably reserves before I/O and settles before response parsing", async () => {
  const ledger = setup();
  const inner = vi.fn(async () => {
    expect(ledger.snapshot().total).toMatchObject({ pendingCalls: 1, committedMicros: 1100 });
    return {
      status: 200,
      json: { model: "test", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    };
  });
  await createCostTransport(inner, ledger, context)(request());
  expect(ledger.snapshot().total).toMatchObject({ pendingCalls: 0, knownMicros: 12 });
});
it("does not let an outer retry spend after an unmeasured failure", async () => {
  const ledger = setup();
  const inner = vi.fn(async () => ({ status: 429, json: { error: "busy" } }));
  const transport = createCostTransport(inner, ledger, context);
  await transport(request());
  await expect(transport(request())).rejects.toThrow(/admission stopped/);
  expect(inner).toHaveBeenCalledTimes(1);
  expect(ledger.snapshot().total).toMatchObject({ unknownCalls: 1, committedMicros: 1100 });
});
it("retains interrupted transport cost and never fabricates zero usage", async () => {
  const ledger = setup();
  const inner = vi.fn(async (): Promise<{ status: number; json: unknown }> => {
    throw new Error("timeout");
  });
  await expect(createCostTransport(inner, ledger, context)(request())).rejects.toThrow("timeout");
  expect(ledger.snapshot()).toMatchObject({
    stopped: true,
    total: { unknownCalls: 1, committedMicros: 1100 },
  });
});
it.each([
  { stream: true },
  { n: 2 },
  { model: "unpriced" },
  { max_tokens: 101 },
  { messages: [{ role: "user", content: [{ type: "image_url", image_url: "fake" }] }] },
  { messages: [{ role: "user", content: "x".repeat(1001) }] },
])("refuses unsupported or unbounded request before I/O: %j", async (patch) => {
  const ledger = setup();
  const inner = vi.fn(async () => ({ status: 200, json: {} }));
  const req = request();
  await expect(
    createCostTransport(inner, ledger, context)({ body: { ...req.body, ...patch } }),
  ).rejects.toThrow();
  expect(inner).not.toHaveBeenCalled();
  expect(ledger.snapshot().total.committedMicros).toBe(0);
});

it("enforces shared admission on a real HTTP completion client", async () => {
  const ledger = setup();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        model: "test",
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
        choices: [{ message: { content: "fixture" } }],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const client = createCompletionClient(
      {
        name: "fixture",
        format: "openai",
        apiKey: "fixture-key-only",
        baseUrl: `http://127.0.0.1:${address.port}`,
        defaultModel: "test",
      },
      createCostTransport(createCompletionFetchTransport(), ledger, context),
    );
    await expect(client.complete({ model: "test", prompt: "hello", maxTokens: 100 })).resolves.toBe(
      "fixture",
    );
    await expect(
      client.complete({ model: "test", prompt: "hello", maxTokens: 100 }),
    ).rejects.toThrow(/admission stopped/);
    expect(requests).toBe(1);
    expect(ledger.snapshot().files.skill?.quarantined).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("prices native Anthropic cache creation TTLs without losing measured input", async () => {
  const ledger = setup("anthropic");
  const send = createCostTransport(
    async () => ({
      status: 200,
      json: {
        model: "test",
        content: [],
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 5,
          cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
        },
      },
    }),
    ledger,
    { ...context, format: "anthropic" },
  );
  await send(request());
  expect(ledger.snapshot().total.knownMicros).toBe(20);
  expect([...ledger.snapshot().calls.values()][0]?.settlement?.usage).toEqual({
    inputTokens: 18,
    outputTokens: 2,
    cachedInputTokens: 3,
    cacheCreationInputTokens: 5,
    cacheCreation5mInputTokens: 2,
    cacheCreation1hInputTokens: 3,
  });
});
it("retains a reservation when individually valid cache subsets overlap", async () => {
  const ledger = setup();
  await createCostTransport(
    async () => ({
      status: 200,
      json: {
        model: "test",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 600 },
        },
      },
    }),
    ledger,
    context,
  )(request());
  expect(ledger.snapshot()).toMatchObject({
    stopped: true,
    total: { unknownCalls: 1, committedMicros: 1100 },
  });
});
