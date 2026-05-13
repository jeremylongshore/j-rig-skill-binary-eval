/**
 * Provider error taxonomy — vendor-neutral.
 *
 * Per the PB-7 measurement protocol (000-docs/018-AT-SPEC-...md § 4 EC-4),
 * the provider-adapter being chosen must map provider-specific errors to a
 * unified taxonomy. This module is the canonical definition of that taxonomy.
 * Any concrete Provider implementation MUST surface errors typed as
 * ProviderError with one of the categories below.
 *
 * Distinguishing "model refused" (legitimate model output, not an error) from
 * "provider errored" (infrastructure/auth/quota issue) is load-bearing —
 * the rollout-gate consumer treats these differently.
 *
 *   - model refusal     → CompletionResult.finishReason === 'refusal'
 *                         (NOT a ProviderError)
 *   - provider error    → throw ProviderError with category
 */

/**
 * Closed enum of error categories. Add new categories only when an existing
 * one cannot honestly describe the failure — narrowing each category's
 * meaning is more useful than fragmenting the taxonomy.
 */
export type ProviderErrorCategory =
  | "authentication" // bad / missing / expired API key, OAuth failure
  | "rate_limit" // provider returned 429 or quota-exhausted equivalent
  | "model_not_found" // requested model name unknown to the provider
  | "content_policy_refusal" // upstream provider blocked the request pre-completion
  | "network_timeout" // socket / connection / read timeout
  | "schema_violation" // provider returned response that did not match request schema
  | "unknown"; // last-resort; the adapter SHOULD avoid this

/**
 * Thrown by Provider implementations. Carries enough metadata for callers
 * (especially the rollout-gate consumer) to make retry / fail-closed
 * decisions without parsing free-text error messages.
 */
export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly providerName: string;
  readonly retryable: boolean;
  readonly originalError?: unknown;

  constructor(args: {
    category: ProviderErrorCategory;
    providerName: string;
    message: string;
    retryable?: boolean;
    originalError?: unknown;
  }) {
    super(args.message);
    this.name = "ProviderError";
    this.category = args.category;
    this.providerName = args.providerName;
    this.retryable = args.retryable ?? defaultRetryableFor(args.category);
    this.originalError = args.originalError;
    // Preserve prototype chain for cross-bundle instanceof
    Object.setPrototypeOf(this, ProviderError.prototype);
  }
}

/** Default retryability per category — adapter MAY override per-call. */
function defaultRetryableFor(c: ProviderErrorCategory): boolean {
  switch (c) {
    case "rate_limit":
    case "network_timeout":
      return true;
    case "authentication":
    case "model_not_found":
    case "content_policy_refusal":
    case "schema_violation":
    case "unknown":
      return false;
  }
}

/** Type guard. */
export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}
