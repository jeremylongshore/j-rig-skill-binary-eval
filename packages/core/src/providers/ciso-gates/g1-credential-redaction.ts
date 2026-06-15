/**
 * CISO Gate G-1: credential redaction.
 *
 * Source: PB-7 measurement protocol § 6 G-1.
 *
 * Test: run the prototype at debug verbosity. Capture every line emitted to
 * stdout, stderr, OTel telemetry (span name + attributes + events), and any
 * local log files (fs writes). Grep the captured output for any contiguous
 * 8+ char substring of the API key.
 *
 * Pass criterion: zero substring matches.
 *
 * Channels captured during the harness window:
 *   1. process.stdout.write / process.stderr.write (teed into the buffer).
 *   2. Local log-file writes via the fs module — fs.writeFileSync,
 *      fs.appendFileSync, fs.createWriteStream (every .write on the returned
 *      stream), and the fs/promises + callback forms of writeFile/appendFile.
 *      Written content is teed into the buffer alongside stdout/stderr.
 *   3. OpenTelemetry spans — an InMemorySpanExporter is installed as the
 *      global tracer provider's delegate for the harness window; after the
 *      adapter runs, every recorded span's name, attribute values, and event
 *      names + attribute values are appended to the buffer.
 *
 * All intercepts/installs are reverted in a finally block so a panicking
 * provider can't leave the process I/O, the fs module, or the global tracer
 * provider permanently rerouted.
 *
 * This module is the canonical test runner. It is NOT a unit test — it is a
 * harness that wraps a real provider invocation, captures all output, and
 * inspects it. The unit tests in g1-credential-redaction.test.ts exercise
 * THIS harness against test fixtures (clean-provider, leaky-provider).
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";

/** Minimum substring length to consider a leak. */
const MIN_LEAK_LENGTH = 8;

export interface G1Result {
  gate: "G-1-credential-redaction";
  pass: boolean;
  reason: string;
  /**
   * The captured combined output (stdout + stderr + fs log-file writes + OTel
   * span text) the harness inspected. Present on FAIL for debugging.
   * Truncated on PASS to avoid bloat.
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
   * call in the adapter. The harness captures stdout + stderr, fs log-file
   * writes, and OTel spans emitted during this function's execution.
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
 * interceptors, fs log-file write interceptors, and an in-memory OTel span
 * recorder that all tee output into a single capture buffer. Every intercept
 * is removed and the global tracer provider's delegate is restored in a
 * finally block so a panicking provider can't leave the process I/O, the fs
 * module, or telemetry permanently rerouted.
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

  // ---- stdout / stderr interception -------------------------------------
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

  // ---- fs log-file interception -----------------------------------------
  const restoreFs = installFsInterceptors(captured);

  // ---- OTel span interception -------------------------------------------
  const restoreOtel = installOtelRecorder();

  const timeoutMs = args.timeoutMs ?? 30_000;
  // Race the invocation against the timeout so a NEVER-settling adapter
  // cannot block the gate forever (which would also leave the interceptors
  // installed permanently). The timeout branch RESOLVES with a sentinel
  // instead of rejecting to avoid unhandled-rejection noise; a late
  // settlement of the losing invocation promise is absorbed by the race.
  const TIMED_OUT = Symbol("g1-timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMED_OUT>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout(TIMED_OUT), timeoutMs);
  });

  let timedOut = false;
  let invocationError: Error | null = null;
  try {
    const raced = await Promise.race([args.invokeProvider(), timeoutPromise]);
    if (raced === TIMED_OUT) timedOut = true;
  } catch (err) {
    invocationError = err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timeoutHandle);
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    // Drain any spans the adapter recorded into the capture buffer, THEN tear
    // the recorder down. Draining before restore ensures we read everything
    // the adapter emitted while our recorder was the active delegate.
    drainRecordedSpans(restoreOtel.exporter, captured);
    restoreFs();
    restoreOtel.restore();
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
      reason: `${leaks.length} substring(s) of the test key appeared in captured stdout+stderr+log-file+OTel-span output; redaction failed`,
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
    reason: `zero key substrings (≥${MIN_LEAK_LENGTH} chars) found in captured stdout+stderr+log-file+OTel-span output${errSuffix}`,
    capturedOutput: truncate(combined, 200),
  };
}

/**
 * Install interceptors over the fs log-file write surface so any credential
 * written to a local log file is teed into `captured`. Covers the synchronous
 * forms (writeFileSync, appendFileSync), the stream form (createWriteStream —
 * every `.write` on the returned stream is teed), and the async forms
 * (fs/promises writeFile/appendFile + the fs callback writeFile/appendFile).
 *
 * Returns a `restore()` that puts EVERY original back. The restore is
 * idempotent-safe: it reassigns the saved originals unconditionally.
 */
function installFsInterceptors(captured: string[]): () => void {
  const origWriteFileSync = fs.writeFileSync;
  const origAppendFileSync = fs.appendFileSync;
  const origCreateWriteStream = fs.createWriteStream;
  const origWriteFileCb = fs.writeFile;
  const origAppendFileCb = fs.appendFile;
  const origPromisesWriteFile = fsPromises.writeFile;
  const origPromisesAppendFile = fsPromises.appendFile;

  fs.writeFileSync = function patchedWriteFileSync(this: unknown, ...callArgs: unknown[]) {
    captured.push(coerceFileData(callArgs[1]));
    return (origWriteFileSync as (...a: unknown[]) => void).apply(fs, callArgs);
  } as typeof fs.writeFileSync;

  fs.appendFileSync = function patchedAppendFileSync(this: unknown, ...callArgs: unknown[]) {
    captured.push(coerceFileData(callArgs[1]));
    return (origAppendFileSync as (...a: unknown[]) => void).apply(fs, callArgs);
  } as typeof fs.appendFileSync;

  fs.createWriteStream = function patchedCreateWriteStream(this: unknown, ...callArgs: unknown[]) {
    const stream = (origCreateWriteStream as (...a: unknown[]) => fs.WriteStream).apply(
      fs,
      callArgs,
    );
    const origStreamWrite = stream.write.bind(stream);
    stream.write = function patchedStreamWrite(this: unknown, ...writeArgs: unknown[]) {
      captured.push(coerceFileData(writeArgs[0]));
      return (origStreamWrite as (...a: unknown[]) => boolean)(...writeArgs);
    } as typeof stream.write;
    return stream;
  } as typeof fs.createWriteStream;

  fs.writeFile = function patchedWriteFileCb(this: unknown, ...callArgs: unknown[]) {
    captured.push(coerceFileData(callArgs[1]));
    return (origWriteFileCb as (...a: unknown[]) => void).apply(fs, callArgs);
  } as typeof fs.writeFile;

  fs.appendFile = function patchedAppendFileCb(this: unknown, ...callArgs: unknown[]) {
    captured.push(coerceFileData(callArgs[1]));
    return (origAppendFileCb as (...a: unknown[]) => void).apply(fs, callArgs);
  } as typeof fs.appendFile;

  fsPromises.writeFile = function patchedPromisesWriteFile(this: unknown, ...callArgs: unknown[]) {
    captured.push(coerceFileData(callArgs[1]));
    return (origPromisesWriteFile as (...a: unknown[]) => Promise<void>).apply(
      fsPromises,
      callArgs,
    );
  } as typeof fsPromises.writeFile;

  fsPromises.appendFile = function patchedPromisesAppendFile(
    this: unknown,
    ...callArgs: unknown[]
  ) {
    captured.push(coerceFileData(callArgs[1]));
    return (origPromisesAppendFile as (...a: unknown[]) => Promise<void>).apply(
      fsPromises,
      callArgs,
    );
  } as typeof fsPromises.appendFile;

  return function restoreFs() {
    fs.writeFileSync = origWriteFileSync;
    fs.appendFileSync = origAppendFileSync;
    fs.createWriteStream = origCreateWriteStream;
    fs.writeFile = origWriteFileCb;
    fs.appendFile = origAppendFileCb;
    fsPromises.writeFile = origPromisesWriteFile;
    fsPromises.appendFile = origPromisesAppendFile;
  };
}

/**
 * Install an in-memory OTel span recorder as the global tracer provider's
 * delegate for the harness window. The global singleton is the
 * `ProxyTracerProvider`; we swap its delegate (saving the prior one) so that:
 *   - any tracer the adapter obtains via the global API records into our
 *     in-memory exporter, AND
 *   - restoring is a single `setDelegate(prior)` that leaves the global
 *     singleton object identity untouched (so callers observing
 *     `trace.getTracerProvider()` see the same object before and after).
 *
 * This sidesteps the once-only semantics of `setGlobalTracerProvider` (which
 * is a no-op if a provider was already installed by the host app).
 */
function installOtelRecorder(): {
  exporter: InMemorySpanExporter;
  restore: () => void;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  // The global is always a ProxyTracerProvider; getDelegate/setDelegate are
  // its public surface (verified against @opentelemetry/api typings).
  const proxy = trace.getTracerProvider() as {
    getDelegate?: () => unknown;
    setDelegate?: (d: unknown) => void;
  };

  // Fallback path: if (somehow) the global is not a proxy with delegate
  // accessors, fall back to setGlobalTracerProvider + disable on restore.
  if (typeof proxy.getDelegate !== "function" || typeof proxy.setDelegate !== "function") {
    trace.setGlobalTracerProvider(provider);
    return {
      exporter,
      restore: () => {
        void provider.shutdown();
        trace.disable();
      },
    };
  }

  const priorDelegate = proxy.getDelegate();
  proxy.setDelegate(provider);

  return {
    exporter,
    restore: () => {
      proxy.setDelegate!(priorDelegate);
      void provider.shutdown();
    },
  };
}

/**
 * Read every span the recorder captured and append its inspectable text —
 * span name, every attribute value, and every event name + event-attribute
 * value — into `captured`. An adapter that emits no spans leaves the exporter
 * empty, which appends nothing (no false positive).
 */
function drainRecordedSpans(exporter: InMemorySpanExporter, captured: string[]): void {
  const spans: ReadableSpan[] = exporter.getFinishedSpans();
  for (const span of spans) {
    captured.push(span.name);
    for (const value of Object.values(span.attributes)) {
      captured.push(coerceAttributeValue(value));
    }
    for (const event of span.events) {
      captured.push(event.name);
      if (event.attributes) {
        for (const value of Object.values(event.attributes)) {
          captured.push(coerceAttributeValue(value));
        }
      }
    }
  }
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

/**
 * Coerce the `data` argument of an fs write call into inspectable text. fs
 * accepts string | Buffer | TypedArray | DataView; anything else is best-effort
 * stringified so a credential cannot hide behind an exotic wrapper type.
 */
function coerceFileData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf-8");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("utf-8");
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("utf-8");
  }
  if (data === undefined || data === null) return "";
  return String(data);
}

/**
 * Coerce an OTel attribute value (string | number | boolean | array thereof)
 * into inspectable text.
 */
function coerceAttributeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => coerceAttributeValue(v)).join(" ");
  if (value === undefined || value === null) return "";
  return String(value);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [truncated ${s.length - max} chars]`;
}
