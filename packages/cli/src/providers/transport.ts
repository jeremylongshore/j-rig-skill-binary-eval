/**
 * Provider transport seam — the single network-touching boundary the
 * measurement adapters depend on.
 *
 * Per PB-7 (`000-docs/018-AT-SPEC-pb7-adapter-measurement-protocol-2026-05-12.md`),
 * the LiteLLM and Vercel AI SDK prototypes each implement the vendor-neutral
 * `Provider` contract from `@j-rig/core`. The interesting, measurable part of
 * each prototype is its REQUEST/RESPONSE NORMALIZATION across vendors — not the
 * raw socket call. To keep the prototypes:
 *
 *   - deterministically testable without live API keys,
 *   - CISO-gate-clean (G-1 credential redaction, G-2 env-var spillover — no
 *     subprocess spawn, no key logging), and
 *   - free of a heavyweight SDK dependency BEFORE the council locks a winner,
 *
 * the actual HTTP call is isolated behind this injectable `Transport` seam. The
 * default transport (`createFetchTransport`) makes a real `fetch` call to a
 * vendor endpoint; tests inject a fake transport that returns canned vendor
 * payloads so normalization logic is exercised end-to-end.
 *
 * This mirrors the structure of the reference fixtures `CleanProvider` /
 * `LeakyProvider` in `@j-rig/core` (no network in the fixture; the adapter is
 * what gets measured).
 */

/** Vendor-shaped HTTP request issued by an adapter. */
export interface TransportRequest {
  /** Fully-qualified endpoint URL. */
  url: string;
  /** HTTP method; adapters use POST for all completion calls. */
  method: "POST";
  /**
   * Request headers. Adapters place the credential here (e.g. `authorization`
   * or `x-api-key`). The transport MUST NOT log or echo header values.
   */
  headers: Record<string, string>;
  /** JSON-serializable request body in the vendor's wire shape. */
  body: unknown;
  /** Abort signal threaded through from the caller's CompletionRequest. */
  signal?: AbortSignal;
}

/** Vendor-shaped HTTP response handed back to the adapter for normalization. */
export interface TransportResponse {
  /** HTTP status code (200, 401, 404, 429, …). */
  status: number;
  /** Parsed JSON body. `null` for empty/non-JSON bodies. */
  json: unknown;
}

/**
 * The network boundary. A `Transport` takes a vendor-shaped request and returns
 * a vendor-shaped response. It NEVER throws for HTTP-level errors (4xx/5xx) —
 * those are returned with their status so the adapter can map them to the
 * unified `ProviderError` taxonomy. It MAY throw only for transport-layer
 * failures (DNS, socket, abort), which adapters translate to
 * `network_timeout`/`unknown`.
 */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/**
 * Default transport: a thin `fetch` wrapper. Used in production paths. Tests
 * inject a fake transport instead, so this code path is intentionally not
 * exercised by the deterministic unit suite (it would require a live network).
 *
 * Credential handling note (CISO G-1): this function reads header values only
 * to pass them to `fetch`. It never logs them. (CISO G-2): it spawns no
 * subprocess and forwards no environment.
 */
export function createFetchTransport(): Transport {
  return async (req: TransportRequest): Promise<TransportResponse> => {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: req.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
}
