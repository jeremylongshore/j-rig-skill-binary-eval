import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@j-rig/core";
import { createMiniMaxPlanTransport, parsePlanQuota } from "./minimax-plan.js";
import { RealOpenAICompatProvider } from "./openai-compatible.js";
import { createFetchTransport } from "./transport.js";
import type { TransportRequest, TransportResponse } from "./transport.js";

const NOW = 1_800_000_000_000;
const request: TransportRequest = {
  url: "https://api.minimax.io/v1/chat/completions",
  method: "POST",
  headers: { authorization: "Bearer synthetic-test-secret" },
  body: { model: "MiniMax-M3", messages: [{ role: "user", content: "private prompt" }] },
};
const success: TransportResponse = { status: 200, json: { choices: [] } };
const limited: TransportResponse = {
  status: 429,
  json: { error: { message: "Token Plan rate limit reached (2062)" } },
};
function quota(overrides: Record<string, unknown> = {}) {
  return {
    base_resp: { status_code: 0 },
    model_remains: [
      {
        model_name: "general",
        current_interval_remaining_percent: 80,
        current_weekly_remaining_percent: 75,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        end_time: NOW + 18_000_000,
        weekly_end_time: NOW + 604_800_000,
        ...overrides,
      },
    ],
  };
}
function setup(responses: TransportResponse[] = [success]) {
  let time = NOW;
  const starts: number[] = [];
  const transport = vi.fn(async () => {
    starts.push(time);
    return responses.shift() ?? success;
  });
  const fetchQuota = vi.fn(async (): Promise<unknown> => quota());
  const sleep = vi.fn(async (ms: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    time += ms;
  });
  const observe = vi.fn();
  const send = createMiniMaxPlanTransport(transport, {
    fetchQuota,
    sleep,
    observe,
    now: () => time,
  });
  return { send, transport, fetchQuota, sleep, observe, starts };
}

describe("MiniMax plan quota", () => {
  it("uses explicit percentages even when legacy counts are zero", () => {
    expect(parsePlanQuota(quota(), "MiniMax-M3").intervalRemainingPercent).toBe(80);
  });

  it("prefers the exact model over wildcard and general rows", () => {
    const data = quota();
    data.model_remains.push(
      ...quota({ model_name: "MiniMax-M3", current_interval_remaining_percent: 0 }).model_remains,
    );
    expect(parsePlanQuota(data, "MiniMax-M3").intervalRemainingPercent).toBe(0);
    expect(
      parsePlanQuota(quota({ model_name: "MiniMax-M*" }), "MiniMax-M3").weeklyRemainingPercent,
    ).toBe(75);
  });

  it.each([
    null,
    { base_resp: { status_code: 1004 }, model_remains: [] },
    quota({ model_name: "video" }),
    quota({ current_interval_remaining_percent: undefined }),
    quota({ current_weekly_remaining_percent: -1 }),
    quota({ current_interval_remaining_percent: 101 }),
    quota({ current_interval_remaining_percent: "80" }),
    quota({ end_time: NaN }),
    quota({ weekly_end_time: 0 }),
  ])("refuses unavailable, ambiguous or malformed quota", (value) => {
    expect(() => parsePlanQuota(value, "MiniMax-M3")).toThrow(ProviderError);
  });
});

describe("MiniMax explicit overload recovery", () => {
  const overload: TransportResponse = {
    status: 503,
    json: { error: { message: "The server cluster is currently under high load. (2064)" } },
  };

  it.each([503, 529])(
    "recovers an explicit HTTP %s overload after fresh quota and cooldown",
    async (status) => {
      const h = setup([{ ...overload, status }, success]);
      expect(await h.send(request)).toBe(success);
      expect(h.starts).toEqual([NOW, NOW + 30_000]);
      expect(h.fetchQuota).toHaveBeenCalledTimes(3);
      expect(h.transport).toHaveBeenCalledTimes(2);
    },
  );

  it.each([2064, "2064"])("accepts a typed explicit overload code %s", async (code) => {
    const h = setup([{ status: 503, json: { error: { code } } }, success]);
    expect(await h.send(request)).toBe(success);
    expect(h.transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 200, json: { choices: [{ message: { content: "" }, finish_reason: "length" }] } },
    { status: 503, json: null },
    { status: 503, json: { error: { message: "upstream timeout (1001)" } } },
    { status: 504, json: overload.json },
    { status: 503, json: { ...(overload.json as object), choices: [] } },
    { status: 503, json: { ...(overload.json as object), usage: { completion_tokens: 5 } } },
  ])("does not replay ambiguous or already completed responses", async (response) => {
    const h = setup([response]);
    expect(await h.send(request)).toBe(response);
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it("honors Retry-After and refuses a delay beyond the shared bound", async () => {
    const h = setup([{ ...overload, retryAfterSeconds: 45 }, success]);
    expect(await h.send(request)).toBe(success);
    expect(h.starts).toEqual([NOW, NOW + 45_000]);
    const tooLong = { ...overload, retryAfterSeconds: 71 };
    const blocked = setup([tooLong]);
    expect(await blocked.send(request)).toBe(tooLong);
    expect(await blocked.send(request)).toBe(tooLong);
    expect(blocked.transport).toHaveBeenCalledTimes(1);
    expect(blocked.sleep).not.toHaveBeenCalled();
  });

  it("keeps the overload cooldown when quota resets sooner", async () => {
    const h = setup([overload, success]);
    h.fetchQuota
      .mockResolvedValueOnce(quota())
      .mockResolvedValueOnce(
        quota({ current_interval_remaining_percent: 0, end_time: NOW + 5_000 }),
      );
    expect(await h.send(request)).toBe(success);
    expect(h.starts).toEqual([NOW, NOW + 30_000]);
  });

  it.each([
    { responses: [overload, success, limited] },
    { responses: [limited, success, overload] },
  ])("shares one recovery between rate limits and overloads", async ({ responses }) => {
    const later = responses[2];
    const h = setup([...responses]);
    expect(await h.send(request)).toBe(success);
    expect(await h.send(request)).toBe(later);
    expect(await h.send(request)).toBe(later);
    expect(h.transport).toHaveBeenCalledTimes(3);
    expect(h.sleep.mock.calls.filter(([ms]) => ms >= 30_000)).toHaveLength(1);
  });

  it("keeps queued work blocked after a failed overload recovery", async () => {
    const h = setup([overload, overload]);
    expect(await Promise.all([h.send(request), h.send(request)])).toEqual([overload, overload]);
    expect(h.transport).toHaveBeenCalledTimes(2);
    const thrown = setup();
    thrown.transport
      .mockResolvedValueOnce(overload)
      .mockRejectedValueOnce(new Error("socket timeout"));
    await expect(thrown.send(request)).rejects.toThrow("socket timeout");
    expect(await thrown.send(request)).toBe(overload);
    expect(thrown.transport).toHaveBeenCalledTimes(2);
  });

  it("refuses an overload retry when the fresh quota is unavailable", async () => {
    const h = setup([overload]);
    h.fetchQuota.mockResolvedValueOnce(quota()).mockResolvedValueOnce(null);
    await expect(h.send(request)).rejects.toThrow("quota response unavailable");
    await expect(h.send(request)).rejects.toThrow("quota response unavailable");
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it("cancels overload cooldown without retrying or reopening queued admission", async () => {
    const h = setup([overload]);
    const controller = new AbortController();
    h.sleep.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(h.send({ ...request, signal: controller.signal })).rejects.toThrow();
    await expect(h.send(request)).rejects.toThrow("recovery did not complete");
    expect(h.transport).toHaveBeenCalledTimes(1);
  });
});

describe("MiniMax nightly admission", () => {
  it("cancels a queued caller promptly while the preceding request is pending", async () => {
    const h = setup();
    let release!: (value: TransportResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    h.transport.mockImplementationOnce(() => {
      markStarted();
      return new Promise<TransportResponse>((resolve) => {
        release = resolve;
      });
    });
    const first = h.send(request);
    await started;
    const controller = new AbortController();
    const queued = h.send({ ...request, signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toThrow();
    expect(h.transport).toHaveBeenCalledTimes(1);
    release(success);
    await first;
    await h.send(request);
    expect(h.transport).toHaveBeenCalledTimes(2);
  });

  it("does not repeatedly dispatch against depleted billing credits", async () => {
    const depleted = { status: 402, json: null };
    const h = setup([depleted]);
    expect(await h.send(request)).toBe(depleted);
    expect(await h.send(request)).toBe(depleted);
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it("spaces concurrent calls, caches quota and never replays accepted responses", async () => {
    const h = setup();
    expect(await Promise.all([h.send(request), h.send(request), h.send(request)])).toEqual([
      success,
      success,
      success,
    ]);
    expect(h.starts).toEqual([NOW, NOW + 1_000, NOW + 2_000]);
    expect(h.fetchQuota).toHaveBeenCalledTimes(1);
    expect(h.transport).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(h.observe.mock.calls)).not.toMatch(
      /synthetic-test-secret|private prompt|Bearer/,
    );
  });

  it("waits once for a short quota reset, then rechecks before admitting a call", async () => {
    const h = setup();
    h.fetchQuota.mockResolvedValueOnce(
      quota({ current_interval_remaining_percent: 0, end_time: NOW + 20_000 }),
    );
    await expect(h.send(request)).resolves.toBe(success);
    expect(h.sleep).toHaveBeenCalledWith(21_000, undefined);
    expect(h.starts).toEqual([NOW + 21_000]);
    expect(h.fetchQuota).toHaveBeenCalledTimes(2);
  });

  it.each([
    { current_interval_remaining_percent: 0 },
    { current_weekly_remaining_percent: 0 },
    {
      current_interval_remaining_percent: 0,
      end_time: NOW + 1_000,
      current_weekly_remaining_percent: 0,
    },
  ])("opens the circuit for a long exhausted window without model requests", async (fields) => {
    const h = setup();
    h.fetchQuota.mockResolvedValue(quota(fields));
    const results = await Promise.allSettled([h.send(request), h.send(request)]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ category: "rate_limit", retryable: false });
    }
    expect(h.fetchQuota).toHaveBeenCalledTimes(1);
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it("recovers one explicit 429 after cooldown and a fresh quota check", async () => {
    const h = setup([limited, success]);
    await expect(h.send(request)).resolves.toBe(success);
    expect(h.starts).toEqual([NOW, NOW + 70_000]);
    expect(h.fetchQuota).toHaveBeenCalledTimes(3);
    expect(h.transport.mock.calls).toHaveLength(2);
  });

  it("waits for the measured reset when 2062 coincides with exhausted quota", async () => {
    const h = setup([limited, success]);
    h.fetchQuota
      .mockResolvedValueOnce(quota())
      .mockResolvedValueOnce(
        quota({ current_interval_remaining_percent: 0, end_time: NOW + 5_000 }),
      );
    await expect(h.send(request)).resolves.toBe(success);
    expect(h.starts).toEqual([NOW, NOW + 6_000]);
  });

  it("opens the circuit if a retry reports depleted billing credits", async () => {
    const depleted = { status: 402, json: null };
    const h = setup([limited, depleted]);
    expect(await h.send(request)).toBe(depleted);
    expect(await h.send(request)).toBe(depleted);
    expect(h.transport).toHaveBeenCalledTimes(2);
  });

  it("never retries before Retry-After or beyond the recovery bound", async () => {
    const h = setup([{ ...limited, retryAfterSeconds: 300 }]);
    await expect(h.send(request)).rejects.toThrow("bounded recovery window");
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500, 503])(
    "keeps queued work blocked after a recovery returns HTTP %s",
    async (status) => {
      const failedRetry = { status, json: null };
      const h = setup([limited, failedRetry]);
      const results = await Promise.all([h.send(request), h.send(request)]);
      expect(results).toEqual([failedRetry, failedRetry]);
      expect(h.transport).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps queued work blocked when the recovery transport throws", async () => {
    const h = setup();
    h.transport.mockResolvedValueOnce(limited).mockRejectedValueOnce(new Error("socket timeout"));
    const results = await Promise.allSettled([h.send(request), h.send(request)]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { message: "socket timeout" } });
    expect(results[1]).toEqual({ status: "fulfilled", value: limited });
    expect(h.transport).toHaveBeenCalledTimes(2);
  });

  it("preserves a persistent 429 for all queued calls after one retry", async () => {
    const h = setup([limited, limited]);
    expect(await Promise.all([h.send(request), h.send(request), h.send(request)])).toEqual([
      limited,
      limited,
      limited,
    ]);
    expect(h.transport).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });

  it("does not grant another recovery after a later rate limit", async () => {
    const h = setup([limited, success, limited]);
    await expect(h.send(request)).resolves.toBe(success);
    await expect(h.send(request)).resolves.toBe(limited);
    await expect(h.send(request)).resolves.toBe(limited);
    expect(h.transport).toHaveBeenCalledTimes(3);
    expect(h.sleep.mock.calls.filter(([ms]) => ms === 70_000)).toHaveLength(1);
  });

  it("refuses admission if the quota remains exhausted after its claimed reset", async () => {
    const h = setup();
    h.fetchQuota.mockResolvedValue(
      quota({ current_interval_remaining_percent: 0, end_time: NOW + 2_000 }),
    );
    await expect(h.send(request)).rejects.toThrow("still exhausted");
    await expect(h.send(request)).rejects.toThrow("still exhausted");
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry timeouts or non-rate-limit HTTP failures", async () => {
    const h = setup([{ status: 503, json: null }]);
    await expect(h.send(request)).resolves.toMatchObject({ status: 503 });
    h.transport.mockRejectedValueOnce(new Error("socket timeout"));
    await expect(h.send(request)).rejects.toThrow("socket timeout");
    expect(h.transport).toHaveBeenCalledTimes(2);
  });

  it("fails closed on quota lookup failure without leaking arbitrary error text", async () => {
    const h = setup();
    h.fetchQuota.mockRejectedValue(new Error("Bearer private-secret"));
    await expect(h.send(request)).rejects.toThrow("quota lookup failed");
    await expect(h.send(request)).rejects.toThrow("quota lookup failed");
    expect(h.fetchQuota).toHaveBeenCalledTimes(1);
    expect(h.transport).not.toHaveBeenCalled();
    expect(JSON.stringify(h.observe.mock.calls)).not.toContain("private-secret");
  });

  it("never sends a gateway credential to the MiniMax quota endpoint", async () => {
    const h = setup();
    await expect(
      h.send({ ...request, url: "https://gateway.example/v1/chat/completions" }),
    ).rejects.toThrow("canonical MiniMax endpoint");
    expect(h.fetchQuota).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("cancels queued calls before network access", async () => {
    const h = setup();
    const controller = new AbortController();
    const result = h.send({ ...request, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(h.fetchQuota).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("cancels a recovery without a retry and closes admission to queued work", async () => {
    const h = setup([limited]);
    const controller = new AbortController();
    h.sleep.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(h.send({ ...request, signal: controller.signal })).rejects.toThrow();
    await expect(h.send(request)).rejects.toThrow("recovery did not complete");
    expect(h.transport).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MiniMax admission production wiring", () => {
  it("uses the same credential for quota and completion, and redacts telemetry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(quota())))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const logs = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = new RealOpenAICompatProvider({
      apiKey: "synthetic-test-secret",
      name: "minimax",
      baseUrl: "https://api.minimax.io/v1",
      minimaxPlanAdmission: true,
    });
    await expect(
      provider.complete({
        model: "MiniMax-M3",
        messages: [{ role: "user", content: "private prompt" }],
      }),
    ).resolves.toMatchObject({ text: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://www.minimax.io/v1/token_plan/remains");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer synthetic-test-secret" },
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(request.url);
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/synthetic-test-secret|private prompt/);
  });

  it.each([401, 500])(
    "refuses a failed quota HTTP request (%s) before a completion",
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("private detail", { status }));
      vi.stubGlobal("fetch", fetchMock);
      const send = createMiniMaxPlanTransport(createFetchTransport());
      await expect(send(request)).rejects.toThrow("quota HTTP request failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves other providers unchanged even if the nightly flag is enabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new RealOpenAICompatProvider({
      apiKey: "synthetic-test-secret",
      name: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      minimaxPlanAdmission: true,
    });
    await provider.complete({ model: "deepseek-v4-flash", messages: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it.each([
    ["12", 12],
    ["Mon, 19 Oct 2026 05:00:30 GMT", 30],
    ["Mon, 19 Oct 2026 04:59:59 GMT", 0],
    ["invalid", undefined],
    [null, undefined],
  ])("normalizes Retry-After %s without changing the error response", async (header, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-19T05:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not json", {
          status: 429,
          headers: header === null ? {} : { "retry-after": header },
        }),
      ),
    );
    const result = await createFetchTransport()(request);
    expect(result).toMatchObject({ status: 429, json: null });
    expect(result.retryAfterSeconds).toBe(expected);
  });
});
