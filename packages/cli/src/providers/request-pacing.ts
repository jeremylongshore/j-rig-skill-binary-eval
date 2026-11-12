import { setTimeout as delay } from "node:timers/promises";
import type { Transport, TransportRequest, TransportResponse } from "./transport.js";

export function requestPacingPolicy(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const rpm = Number(raw);
  if (!/^\d+(?![\s\S])/.test(raw) || !Number.isSafeInteger(rpm) || rpm < 1 || rpm > 60_000) {
    throw new Error("--judge-requests-per-minute must be an integer from 1 to 60000");
  }
  return {
    schema: "j-rig/request-pacing/v1" as const,
    requests_per_minute: rpm,
    minimum_start_interval_ms: Math.ceil(60_000 / rpm),
    scope: "invocation-selected-judge-endpoints-all-completions" as const,
  };
}
export type RequestPacingPolicy = NonNullable<ReturnType<typeof requestPacingPolicy>>;
interface Clock {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
interface Admission {
  beforeDispatch?: () => void;
  remainingWallMs?: () => number | undefined;
}
interface EndpointState {
  tail: Promise<unknown>;
  lastStart: number;
}

/** Admission only: responses may overlap; queues never reset between criteria/models. */
export class RequestPacer {
  readonly #selected = new Set<string>();
  readonly #states = new Map<string, EndpointState>();
  readonly #now: () => number;
  readonly #sleep: NonNullable<Clock["sleep"]>;
  constructor(
    readonly policy: RequestPacingPolicy,
    clock: Clock = {},
  ) {
    this.#now = clock.now ?? (() => performance.now());
    this.#sleep =
      clock.sleep ??
      (async (ms, signal) => {
        await delay(ms, undefined, { signal });
      });
  }
  selectEndpoint(url: string): void {
    this.#selected.add(new URL(url).href);
  }
  wrap(inner: Transport, admission: Admission = {}, floorMs = 0): Transport {
    return (request) => this.dispatch(request, inner, admission, floorMs);
  }
  async dispatch(
    request: TransportRequest,
    inner: Transport,
    admission: Admission = {},
    floorMs = 0,
  ): Promise<TransportResponse> {
    const key = new URL(request.url).href;
    const interval = Math.max(
      floorMs,
      this.#selected.has(key) ? this.policy.minimum_start_interval_ms : 0,
    );
    if (interval === 0) return inner(request);
    const remaining = admission.remainingWallMs?.();
    admission.beforeDispatch?.();
    const wall =
      remaining === undefined ? undefined : AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    const signals = [request.signal, wall].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const state = this.#states.get(key) ?? { tail: Promise.resolve(), lastStart: -Infinity };
    this.#states.set(key, state);
    const scheduled = state.tail.then(async () => {
      signal?.throwIfAborted();
      while (state.lastStart + interval > this.#now()) {
        await this.#sleep(state.lastStart + interval - this.#now(), signal);
        signal?.throwIfAborted();
      }
      signal?.throwIfAborted();
      admission.beforeDispatch?.();
      // The inner transport may synchronously validate/reserve cost before fetch.
      // Anchor after that invocation, conservatively including synchronous throws,
      // so variable ledger latency cannot shrink the actual wire-start interval.
      try {
        return { response: inner({ ...request, ...(signal ? { signal } : {}) }) };
      } finally {
        state.lastStart = this.#now();
      }
    });
    state.tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    const result = scheduled.then(({ response }) => response);
    if (!signal) return result;
    return new Promise((resolve, reject) => {
      const abort = () => {
        try {
          admission.beforeDispatch?.();
        } catch (error) {
          reject(error);
          return;
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
