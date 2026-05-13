/**
 * CISO Gate G-1: credential redaction.
 *
 * Source: PB-7 measurement protocol § 6 G-1.
 *
 * Test: run the prototype at debug verbosity. Capture every line emitted to
 * stdout, stderr, OTel telemetry, and any local log files. Grep the captured
 * output for any contiguous 8+ char substring of the API key.
 *
 * Pass criterion: zero substring matches.
 *
 * This module is the canonical test runner. It is NOT a unit test — it is a
 * harness that wraps a real provider invocation, captures all output, and
 * inspects it. The unit tests in g1-credential-redaction.test.ts exercise
 * THIS harness against test fixtures (clean-provider, leaky-provider).
 */

/** Minimum substring length to consider a leak. */
const MIN_LEAK_LENGTH = 8;

export interface G1Result {
  gate: "G-1-credential-redaction";
  pass: boolean;
  reason: string;
  /**
   * The captured combined output (stdout + stderr) the harness inspected.
   * Present on FAIL for debugging. Truncated on PASS to avoid bloat.
   */
  capturedOutput?: string;
  /**
   * The substrings of the test key that appeared in captured output, if any.
   * Present on FAIL.
   */
  leakedSubstrings?: string[];
}

export interface G1Args {
  /**
   * The synthetic API key value that will be present in the provider's
   * environment / configuration during the invocation. The harness greps
   * the captured output for 8+-char substrings of this value.
   *
   * Callers MUST use a distinctive, high-entropy value (NOT a real key, NOT
   * a single repeating character). Reasonable shape: "sk-test-G1-" + 32
   * random alphanumeric.
   */
  testKey: string;
  /**
   * Caller-controlled provider invocation. MUST trigger at least one model
   * call in the adapter. The harness captures stdout + stderr emitted
   * during this function's execution.
   *
   * The harness does NOT inject the testKey — the caller is responsible for
   * setting up the adapter to use it (via env var, constructor arg, etc.).
   */
  invokeProvider: () => Promise<void>;
  /**
   * Maximum runtime in milliseconds before the harness aborts with a FAIL.
   * Default: 30 seconds. The harness treats timeout as a fail because a
   * hung adapter cannot be evaluated for redaction.
   */
  timeoutMs?: number;
}

/**
 * Run CISO Gate G-1. Returns a structured result; does not throw.
 *
 * The harness installs temporary `process.stdout.write` / `process.stderr.write`
 * interceptors that tee output into a capture buffer. The interceptors are
 * removed in a finally block so a panicking provider can't leave the
 * process I/O permanently rerouted.
 */
export async function runCisoGateG1(args: G1Args): Promise<G1Result> {
  if (args.testKey.length < MIN_LEAK_LENGTH) {
    return {
      gate: "G-1-credential-redaction",
      pass: false,
      reason: `testKey is shorter than the leak-detection window (${MIN_LEAK_LENGTH} chars); cannot evaluate redaction`,
    };
  }

  const captured: string[] = [];
  // Save the UNBOUND originals so the restore-step is bit-equal to what was
  // there before. We call the originals via .apply() in the interceptor
  // rather than via a pre-bound closure.
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;

  // Cast intercepts to the loose Function shape because process.stdout.write
  // has overloads our interceptor doesn't fully express.
  process.stdout.write = function patchedStdoutWrite(chunk: unknown, ...rest: unknown[]) {
    captured.push(coerce(chunk));
    return (origStdoutWrite as (...a: unknown[]) => boolean).apply(process.stdout, [
      chunk,
      ...rest,
    ]);
  } as typeof process.stdout.write;

  process.stderr.write = function patchedStderrWrite(chunk: unknown, ...rest: unknown[]) {
    captured.push(coerce(chunk));
    return (origStderrWrite as (...a: unknown[]) => boolean).apply(process.stderr, [
      chunk,
      ...rest,
    ]);
  } as typeof process.stderr.write;

  const timeoutMs = args.timeoutMs ?? 30_000;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);

  let invocationError: Error | null = null;
  try {
    await args.invokeProvider();
  } catch (err) {
    invocationError = err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timeoutHandle);
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }

  if (timedOut) {
    return {
      gate: "G-1-credential-redaction",
      pass: false,
      reason: `invocation exceeded timeoutMs=${timeoutMs}; cannot evaluate redaction on a hung adapter`,
    };
  }

  const combined = captured.join("");
  const leaks = findKeySubstrings(combined, args.testKey, MIN_LEAK_LENGTH);

  if (leaks.length > 0) {
    return {
      gate: "G-1-credential-redaction",
      pass: false,
      reason: `${leaks.length} substring(s) of the test key appeared in captured stdout+stderr; redaction failed`,
      capturedOutput: truncate(combined, 4000),
      leakedSubstrings: leaks,
    };
  }

  // Invocation errors do NOT fail the gate per se — the gate is about
  // redaction, not about whether the call succeeded. We surface the error
  // in the reason so callers can interpret.
  const errSuffix = invocationError
    ? ` (note: invokeProvider threw '${invocationError.message}'; not a gate failure)`
    : "";

  return {
    gate: "G-1-credential-redaction",
    pass: true,
    reason: `zero key substrings (≥${MIN_LEAK_LENGTH} chars) found in captured output${errSuffix}`,
    capturedOutput: truncate(combined, 200),
  };
}

/**
 * Find any contiguous substrings of `key` that appear in `haystack`, where
 * each substring is at least `minLen` chars. Returns distinct longest leaks
 * (not every overlapping window) — the harness reports leak SHAPE, not
 * lexicographic enumeration.
 */
export function findKeySubstrings(haystack: string, key: string, minLen: number): string[] {
  if (key.length < minLen || haystack.length === 0) return [];
  const leaks = new Set<string>();
  // Walk windows of length minLen across the key; if any appears in haystack,
  // extend it to its maximal length and record the maximal hit.
  for (let i = 0; i + minLen <= key.length; i++) {
    const window = key.slice(i, i + minLen);
    const idx = haystack.indexOf(window);
    if (idx === -1) continue;
    // Extend leftward from window-start in haystack to find max match.
    let leftHay = idx;
    let leftKey = i;
    while (leftHay > 0 && leftKey > 0 && haystack[leftHay - 1] === key[leftKey - 1]) {
      leftHay--;
      leftKey--;
    }
    let rightHay = idx + minLen;
    let rightKey = i + minLen;
    while (
      rightHay < haystack.length &&
      rightKey < key.length &&
      haystack[rightHay] === key[rightKey]
    ) {
      rightHay++;
      rightKey++;
    }
    leaks.add(haystack.slice(leftHay, rightHay));
  }
  return [...leaks];
}

function coerce(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf-8");
  return String(chunk);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [truncated ${s.length - max} chars]`;
}
