/**
 * Redact credential-shaped material from a provider error message before it
 * crosses into anything durable: a JudgmentResult's `reasoning`/`judge_error`,
 * a signed gate-result/v1 `gate_reasons` entry, or operator console output.
 *
 * Provider SDKs and HTTP transports routinely echo the failing request in
 * their error text (Authorization headers, `?key=` query strings, the raw
 * response body). The repo blueprint (000-docs/021 § credential boundary)
 * requires every error, log, or metric that contains a provider response to
 * be redacted. This is that boundary for the judge path.
 *
 * Deterministic and dependency-free so it can run inside the kernel package.
 * It over-redacts by design: a long opaque token in an error message is never
 * load-bearing for a verifier, but a leaked key is unrecoverable once signed
 * into Rekor.
 */

const REDACTED = "[redacted]";

// Exact host-owned messages contain no external/provider text. Do not exempt
// a prefix or arbitrary suffix: those could carry echoed credentials.
const SAFE_TOOL_FAILURES = new Set(
  [
    "observation_identity_missing",
    "observation_limit",
    "tool_inventory",
    "output_limit",
    "incomplete_response",
    "missing_tool_call",
    "unexpected_tool_call",
    "invalid_tool_call",
    "call_or_output_limit",
    "turn_limit",
    "timeout",
    "transport_failed",
    "cleanup_failed",
  ].map((reason) => `tool_execution/${reason}`),
);

/** Longest error text we allow into a signed reason. */
export const MAX_PROVIDER_ERROR_CHARS = 240;

/**
 * The same credential rules as {@link redactProviderError}, without the
 * provider-error truncation. Used for recorded tool-call summaries (the
 * claude-code trajectory), which keep their own length bound.
 */
export function redactCredentials(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization / Bearer / Basic headers, any casing, any whitespace.
  [/\b(authorization\s*[:=]\s*)(\S+(?:\s+\S+)?)/gi, `$1${REDACTED}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  [/\b(basic\s+)[A-Za-z0-9+/=]{8,}/gi, `$1${REDACTED}`],
  // key=..., api_key=..., token=..., secret=..., password=... (query strings, JSON, dotenv).
  [
    /\b((?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|key)\s*["']?\s*[:=]\s*["']?)([^\s"'&,;]{4,})/gi,
    `$1${REDACTED}`,
  ],
  // Well-known key prefixes (Anthropic, OpenAI, GitHub, Groq, npm, Slack, AWS, Google).
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8,})/g, REDACTED],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, REDACTED],
  [/\b(gsk_[A-Za-z0-9]{16,})/g, REDACTED],
  [/\b(npm_[A-Za-z0-9]{16,})/g, REDACTED],
  [/\b(xox[abpr]-[A-Za-z0-9-]{10,})/g, REDACTED],
  [/\b(AKIA[0-9A-Z]{16})\b/g, REDACTED],
  [/\b(AIza[0-9A-Za-z_-]{20,})/g, REDACTED],
  // JWTs: three base64url segments.
  [/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED],
  // Any remaining long opaque run (hex / base64 / token-like), 32+ chars.
  [/(?<![A-Za-z0-9._/-])[A-Za-z0-9_+/=-]{32,}(?![A-Za-z0-9._/-])/g, REDACTED],
];

/**
 * Return `message` with credential-shaped substrings replaced by `[redacted]`
 * and the result truncated to MAX_PROVIDER_ERROR_CHARS. Never throws; a
 * non-string input is stringified first.
 */
export function redactProviderError(message: unknown): string {
  let out = typeof message === "string" ? message : String(message);
  if (SAFE_TOOL_FAILURES.has(out)) return out;
  out = redactCredentials(out);
  if (out.length > MAX_PROVIDER_ERROR_CHARS) {
    out = `${out.slice(0, MAX_PROVIDER_ERROR_CHARS - 1)}…`;
  }
  return out;
}
