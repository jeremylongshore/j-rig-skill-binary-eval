import { CostLedger, createCostTransport } from "@intentsolutions/refiner";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RequestPacer, requestPacingPolicy } from "./request-pacing.js";
import { createMiniMaxPlanTransport } from "./minimax-plan.js";
import { BudgetGuardedProvider, RunBudget } from "./budget.js";
import { CostTrackingProvider, EvalCostMeter } from "./cost-tracking.js";
import { RealOpenAICompatProvider } from "./openai-compatible.js";
import type { Transport, TransportRequest } from "./transport.js";

const url = "https://fixture.invalid/v1/chat/completions";
const request: TransportRequest = { url, method: "POST", headers: {}, body: { model: "fixture" } };
const response = { status: 200, json: {} };
function clock() {
  let time = 0;
  const sleep = vi.fn(async (ms: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    time += ms;
  });
  return {
    now: () => time,
    sleep,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
afterEach(() => vi.restoreAllMocks());
it.each(["0", "-1", "1.5", "NaN", "Infinity", "60001", "30\n", " 30"])(
  "rejects invalid explicit rate %j",
  (raw) => expect(() => requestPacingPolicy(raw)).toThrow(/integer/),
);
it("default is absent and bounded rates are explicit operator policy", () => {
  expect(requestPacingPolicy(undefined)).toBeUndefined();
  expect(requestPacingPolicy("1")?.minimum_start_interval_ms).toBe(60000);
  expect(requestPacingPolicy("30")).toMatchObject({
    requests_per_minute: 30,
    minimum_start_interval_ms: 2000,
  });
  expect(requestPacingPolicy("60000")?.minimum_start_interval_ms).toBe(1);
});
it("spaces concurrent requests without serializing response completion", async () => {
  const c = clock();
  const p = new RequestPacer(requestPacingPolicy("30")!, c);
  p.selectEndpoint(url);
  const starts: number[] = [];
  let finish: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const inner: Transport = async () => {
    starts.push(c.now());
    if (starts.length === 1) await blocked;
    return response;
  };
  const send = p.wrap(inner);
  const first = send(request);
  const second = send(request);
  await second;
  expect(starts).toEqual([0, 2000]);
  finish!();
  await first;
  // A later criterion/outcome/model uses the same scheduler and cannot reset its clock.
  await p.wrap(inner)(request);
  expect(starts).toEqual([0, 2000, 4000]);
});
it("does not throttle unselected endpoints or replay failed calls", async () => {
  const c = clock();
  const p = new RequestPacer(requestPacingPolicy("30")!, c);
  p.selectEndpoint(url);
  const inner = vi
    .fn<Transport>()
    .mockRejectedValueOnce(new Error("wire failed"))
    .mockResolvedValue(response);
  await expect(p.wrap(inner)(request)).rejects.toThrow("wire failed");
  await p.wrap(inner)({ ...request, url: "https://other.invalid/messages" });
  expect(c.sleep).not.toHaveBeenCalled();
  await p.wrap(inner)(request);
  expect(c.now()).toBe(2000);
  expect(inner).toHaveBeenCalledTimes(3);
});
it("aborted queued requests never reach admission or wire and do not consume a start", async () => {
  const c = clock();
  const p = new RequestPacer(requestPacingPolicy("30")!, c);
  p.selectEndpoint(url);
  const inner = vi.fn<Transport>(async () => response);
  await p.wrap(inner)(request);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(p.wrap(inner)({ ...request, signal: controller.signal })).rejects.toThrow(
    "cancelled",
  );
  await p.wrap(inner)(request);
  expect(inner).toHaveBeenCalledTimes(2);
  expect(c.now()).toBe(2000);
});
it("rechecks wall budget after waiting before any new wire admission", async () => {
  const c = clock();
  const budget = new RunBudget({ max_wall_ms: 1500 }, {}, c.now);
  const p = new RequestPacer(requestPacingPolicy("30")!, c);
  p.selectEndpoint(url);
  const reserveThenSend = vi.fn<Transport>(async () => response);
  const send = p.wrap(reserveThenSend, { beforeDispatch: () => budget.assertDispatchWithin() });
  await send(request);
  await expect(send(request)).rejects.toThrow(/budget exhausted/);
  expect(reserveThenSend).toHaveBeenCalledTimes(1);
  expect(budget.stop?.limit).toBe("max_wall_ms");
});
it("does not reject the first already-metered call at max_calls=1", async () => {
  const c = clock();
  const budget = new RunBudget({ max_calls: 1 }, {}, c.now);
  const meter = new EvalCostMeter();
  budget.attach(meter, "fixture");
  const p = new RequestPacer(requestPacingPolicy("30")!, c);
  p.selectEndpoint(url);
  const wire = vi.fn<Transport>(async () => ({
    status: 200,
    json: {
      model: "fixture",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  }));
  const native = new RealOpenAICompatProvider({
    apiKey: "synthetic-fixture",
    baseUrl: "https://fixture.invalid/v1",
    transport: p.wrap(wire, { beforeDispatch: () => budget.assertDispatchWithin() }),
  });
  const provider = new BudgetGuardedProvider(new CostTrackingProvider(native, meter), budget);
  const completion = {
    model: "fixture",
    messages: [{ role: "user" as const, content: "fixture" }],
  };
  await expect(provider.complete(completion)).resolves.toMatchObject({ text: "ok" });
  await expect(provider.complete(completion)).rejects.toThrow(/budget exhausted/);
  expect(wire).toHaveBeenCalledTimes(1);
});
it.each([30, 120])(
  "composes MiniMax floor and %i RPM as max without changing quota admission",
  async (rpm) => {
    const c = clock();
    const p = new RequestPacer(requestPacingPolicy(String(rpm))!, c);
    const req = {
      ...request,
      url: "https://api.minimax.io/v1/chat/completions",
      body: { model: "MiniMax-M3" },
    };
    p.selectEndpoint(req.url);
    const starts: number[] = [];
    const wire: Transport = async () => {
      starts.push(c.now());
      return response;
    };
    const send = createMiniMaxPlanTransport(wire, {
      ...c,
      observe: () => {},
      fetchQuota: async () => ({
        base_resp: { status_code: 0 },
        model_remains: [
          {
            model_name: "general",
            current_interval_remaining_percent: 80,
            current_weekly_remaining_percent: 80,
            end_time: 1_800_000_000_000,
            weekly_end_time: 1_800_000_000_000,
          },
        ],
      }),
      dispatch: (r, inner) => p.dispatch(r, inner, {}, 1000),
    });
    await send(req);
    await send(req);
    await send(req);
    const interval = Math.max(1000, 60000 / rpm);
    expect(starts).toEqual([0, interval, interval * 2]);
  },
);

it("paces both MiniMax wire attempts while retaining its single recovery and circuit", async () => {
  const c = clock();
  const p = new RequestPacer(requestPacingPolicy("30")!, c);
  const req = {
    ...request,
    url: "https://api.minimax.io/v1/chat/completions",
    body: { model: "MiniMax-M3" },
  };
  p.selectEndpoint(req.url);
  const starts: number[] = [];
  const limited = { status: 429, json: { error: { message: "fixture limit" } } };
  const wire: Transport = async () => {
    starts.push(c.now());
    return starts.length === 2 ? response : limited;
  };
  const send = createMiniMaxPlanTransport(wire, {
    ...c,
    observe: () => {},
    fetchQuota: async () => ({
      base_resp: { status_code: 0 },
      model_remains: [
        {
          model_name: "general",
          current_interval_remaining_percent: 80,
          current_weekly_remaining_percent: 80,
          end_time: 1_800_000_000_000,
          weekly_end_time: 1_800_000_000_000,
        },
      ],
    }),
    dispatch: (r, inner) => p.dispatch(r, inner, {}, 1000),
  });
  await expect(send(req)).resolves.toEqual(response);
  await expect(send(req)).resolves.toEqual(limited);
  await expect(send(req)).resolves.toEqual(limited);
  expect(starts).toEqual([0, 70000, 72000]);
});
it("cancels during a queued wait promptly and continues without sending the cancelled request", async () => {
  let time = 0;
  let waiting: (() => void) | undefined;
  const began = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const p = new RequestPacer(requestPacingPolicy("30")!, {
    now: () => time,
    sleep: async (_ms, signal) => {
      waiting!();
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
      );
    },
  });
  p.selectEndpoint(url);
  const wire = vi.fn<Transport>(async () => response);
  const send = p.wrap(wire);
  await send(request);
  const controller = new AbortController();
  const pending = send({ ...request, signal: controller.signal });
  const assertion = expect(pending).rejects.toThrow("cancelled while waiting");
  await began;
  controller.abort(new Error("cancelled while waiting"));
  await assertion;
  time = 2000;
  await send(request);
  expect(wire).toHaveBeenCalledTimes(2);
});

it("does not reserve governed cost for a queued dispatch refused after waiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "paced-ledger-"));
  try {
    const ledger = new CostLedger(join(root, "ledger.jsonl"), {
      schema: "refiner-cost-policy/v1",
      profile: "custom",
      scopeId: "fixture",
      source: "synthetic",
      files: ["skill"],
      rates: [
        {
          provider: "fixture",
          model: "fixture",
          reportedModels: ["fixture"],
          format: "openai",
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
      maxFileMicros: 5000,
      maxTotalMicros: 5000,
      meanFileBudgetMicros: 3000,
      stopBasisPoints: 8000,
    });
    const c = clock();
    const p = new RequestPacer(requestPacingPolicy("30")!, c);
    p.selectEndpoint(url);
    const budget = new RunBudget({ max_wall_ms: 1500 }, {}, c.now);
    const reserve = vi.spyOn(ledger, "reserve");
    const wire = vi.fn<Transport>(async () => ({
      status: 200,
      json: { model: "fixture", usage: { prompt_tokens: 1, completion_tokens: 1 } },
    }));
    const send = p.wrap(
      createCostTransport(wire, ledger, {
        provider: "fixture",
        format: "openai",
        fileId: "skill",
        attemptId: "attempt",
        phase: "judge",
      }),
      { beforeDispatch: () => budget.assertDispatchWithin() },
    );
    const req = {
      ...request,
      body: { model: "fixture", max_tokens: 100, messages: [{ role: "user", content: "fixture" }] },
    };
    await send(req);
    await expect(send(req)).rejects.toThrow(/budget exhausted/);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps actual wire starts apart when synchronous ledger admission has unequal latency", async () => {
  const c = clock();
  const p = new RequestPacer(requestPacingPolicy("30")!, c);
  p.selectEndpoint(url);
  const starts: number[] = [];
  const send = p.wrap(async () => {
    if (starts.length === 0) c.advance(500);
    starts.push(c.now());
    return response;
  });
  await send(request);
  await send(request);
  expect(starts).toEqual([500, 2500]);
});
