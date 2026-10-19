import { setTimeout as delay } from "node:timers/promises";
import { ProviderError } from "@j-rig/core";
import type { Transport, TransportRequest, TransportResponse } from "./transport.js";

const QUOTA_URL = "https://www.minimax.io/v1/token_plan/remains";
const COMPLETION_URL = "https://api.minimax.io/v1/chat/completions";
const RECOVERY_MS = 70_000;
const CACHE_MS = 30_000;

/** Explicit rejected overload only; never infer retry safety from a generic 5xx. */
function isRejectedOverload(response: TransportResponse): boolean {
  if (response.status !== 503 && response.status !== 529) return false;
  const body = record(response.json);
  if ("choices" in body || "usage" in body) return false;
  const error = record(body.error);
  return (
    error.code === 2064 ||
    error.code === "2064" ||
    (typeof error.message === "string" && error.message.trimEnd().endsWith("(2064)"))
  );
}

export interface PlanQuota {
  intervalRemainingPercent: number;
  weeklyRemainingPercent: number;
  intervalResetAt: number;
  weeklyResetAt: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function unavailable(message: string): ProviderError {
  return new ProviderError({
    category: "rate_limit",
    providerName: "minimax",
    message,
    retryable: false,
  });
}

/** Explicit percentages only: legacy usage_count has incompatible interpretations. */
export function parsePlanQuota(value: unknown, model: unknown): PlanQuota {
  if (typeof model !== "string" || model.length === 0) {
    throw unavailable("MiniMax plan admission: model is required");
  }
  const body = record(value);
  const models = body.model_remains;
  if (record(body.base_resp).status_code !== 0 || !Array.isArray(models)) {
    throw unavailable("MiniMax plan admission: quota response unavailable");
  }
  const rows = models.map(record);
  const row =
    rows.find((r) => r.model_name === model) ??
    rows.find((r) => r.model_name === "MiniMax-M*") ??
    rows.find((r) => r.model_name === "general");
  const percent = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
  const timestamp = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (
    !row ||
    !percent(row.current_interval_remaining_percent) ||
    !percent(row.current_weekly_remaining_percent) ||
    !timestamp(row.end_time) ||
    !timestamp(row.weekly_end_time)
  ) {
    throw unavailable("MiniMax plan admission: explicit quota percentages/reset times unavailable");
  }
  return {
    intervalRemainingPercent: row.current_interval_remaining_percent,
    weeklyRemainingPercent: row.current_weekly_remaining_percent,
    intervalResetAt: row.end_time,
    weeklyResetAt: row.weekly_end_time,
  };
}

export interface PlanAdmissionOptions {
  fetchQuota?: (req: TransportRequest) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  observe?: (event: Record<string, string | number>) => void;
}

/**
 * Nightly opt-in, scoped to the public MiniMax endpoint. A serialized queue
 * spaces starts by >=1s and shares one recovery allowance per provider instance.
 * Successful completions are never replayed. A failed recovery opens the
 * circuit: queued calls cannot keep spending against an exhausted plan.
 */
export function createMiniMaxPlanTransport(
  transport: Transport,
  options: PlanAdmissionOptions = {},
): Transport {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    (async (ms, signal) => {
      await delay(ms, undefined, { signal });
    });
  const observe =
    options.observe ?? ((event) => console.error("minimax-plan", JSON.stringify(event)));
  const fetchQuota =
    options.fetchQuota ??
    (async (req) => {
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetch(QUOTA_URL, {
        headers: { authorization: req.headers.authorization! },
        redirect: "error",
        signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
      });
      if (!response.ok) throw unavailable("MiniMax plan admission: quota HTTP request failed");
      return response.json() as Promise<unknown>;
    });
  let queue: Promise<unknown> = Promise.resolve();
  let quota: PlanQuota | undefined;
  let checkedAt = -Infinity;
  let quotaModel: unknown;
  let nextStart = 0;
  let recoveryUsed = false;
  let circuit: ProviderError | TransportResponse | undefined;

  async function readQuota(req: TransportRequest, force = false): Promise<PlanQuota> {
    const model = record(req.body).model;
    if (!quota || force || model !== quotaModel || now() - checkedAt >= CACHE_MS) {
      try {
        quota = parsePlanQuota(await fetchQuota(req), model);
        quotaModel = model;
      } catch (error) {
        req.signal?.throwIfAborted();
        // Never echo a response, request, credential, or arbitrary network error.
        circuit =
          error instanceof ProviderError
            ? error
            : unavailable("MiniMax plan admission: quota lookup failed");
        throw circuit;
      }
      checkedAt = now();
      observe({ event: "quota", observedAt: checkedAt, ...quota });
    }
    return quota;
  }

  function blockedUntil(q: PlanQuota): number | undefined {
    const resets = [
      ...(q.intervalRemainingPercent === 0 ? [q.intervalResetAt] : []),
      ...(q.weeklyRemainingPercent === 0 ? [q.weeklyResetAt] : []),
    ];
    return resets.length ? Math.max(...resets) : undefined;
  }

  async function recover(req: TransportRequest, waitMs: number): Promise<void> {
    if (recoveryUsed || waitMs > RECOVERY_MS) {
      circuit = unavailable(
        "MiniMax plan admission: allowance unavailable within bounded recovery window",
      );
      throw circuit;
    }
    recoveryUsed = true;
    circuit = unavailable("MiniMax plan admission: recovery did not complete");
    observe({ event: "cooldown", waitMs });
    await sleep(waitMs, req.signal);
    req.signal?.throwIfAborted();
    const current = await readQuota(req, true);
    if (blockedUntil(current) !== undefined) {
      circuit = unavailable("MiniMax plan admission: allowance still exhausted after bounded wait");
      throw circuit;
    }
    circuit = undefined;
  }

  async function send(req: TransportRequest): Promise<TransportResponse> {
    req.signal?.throwIfAborted();
    // Do not forward a gateway credential to MiniMax's quota service.
    if (req.url !== COMPLETION_URL) {
      throw unavailable("MiniMax plan admission requires the canonical MiniMax endpoint");
    }
    if (circuit instanceof ProviderError) throw circuit;
    if (circuit) return circuit;
    const current = await readQuota(req);
    const reset = blockedUntil(current);
    if (reset !== undefined) await recover(req, Math.max(1_000, reset - now() + 1_000));
    if (nextStart > now()) await sleep(nextStart - now(), req.signal);
    req.signal?.throwIfAborted();
    nextStart = now() + 1_000;
    const response = await transport(req);
    if (response.status === 402) circuit = response;
    const overload = isRejectedOverload(response);
    if (response.status !== 429 && !overload) return response;
    // Rate limits and explicit no-output overloads share ONE recovery allowance.
    // Never replay an ambiguous timeout, generic 5xx, or completed output.
    circuit = response;
    if (recoveryUsed) return response;
    const afterLimit = await readQuota(req, true);
    const resetAfterLimit = blockedUntil(afterLimit);
    const retryAfter = response.retryAfterSeconds;
    const waitMs = Math.max(
      overload ? 30_000 : 0,
      resetAfterLimit === undefined
        ? overload
          ? 30_000
          : RECOVERY_MS
        : Math.max(1_000, resetAfterLimit - now() + 1_000),
      retryAfter === undefined ? 0 : retryAfter * 1_000,
    );
    if (overload && waitMs > RECOVERY_MS) return response;
    await recover(req, waitMs);
    // The positive quota check permits one retry; only a successful HTTP
    // response proves recovery. Keep the original limit if the retry throws.
    circuit = response;
    req.signal?.throwIfAborted();
    nextStart = now() + 1_000;
    const retried = await transport(req);
    circuit = retried.status >= 200 && retried.status < 300 ? undefined : retried;
    return retried;
  }

  return (req) => {
    const result = queue.then(() => send(req));
    queue = result.catch(() => undefined);
    if (!req.signal) return result;
    const signal = req.signal;
    return new Promise<TransportResponse>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      result.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  };
}
