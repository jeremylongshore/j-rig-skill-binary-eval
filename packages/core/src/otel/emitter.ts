/**
 * Best-effort OTel emitter for the j-rig behavioral-eval execution path
 * (iaj-E08).
 *
 * DESIGN (mirrors the audit-harness iah-E07 emitter,
 * `audit-harness/scripts/emit-evidence.sh` lines 194-326):
 *
 *   - **Best-effort, no-op default.** A collector being absent is the no-op
 *     path. Emission NEVER throws into the eval pipeline — a malformed payload
 *     or a missing OTel SDK degrades to "nothing emitted", and the eval's own
 *     result is never affected (iah-E07c parity). This is the load-bearing
 *     safety property: instrumentation can never break an eval run.
 *
 *   - **Two transports, both opt-in:**
 *       1. **OTel API spans/events.** When a TracerProvider is registered
 *          globally (consumer wires `@opentelemetry/sdk-trace-*` +
 *          `OTEL_EXPORTER_OTLP_ENDPOINT`), each emitted event is attached to a
 *          span via the real `@opentelemetry/api`. If no provider is
 *          registered, `trace.getTracer` returns a no-op tracer and the call is
 *          a genuine no-op — zero overhead, zero output.
 *       2. **`[OTEL]`-marker JSON lines to stderr.** When `J_RIG_OTEL=1` OR
 *          `OTEL_EXPORTER_OTLP_ENDPOINT` is set, each event is ALSO printed as a
 *          single-line OTLP-shaped JSON to stderr prefixed with `[OTEL] ` — the
 *          exact stderr-scrape contract the audit-harness emitter publishes, so
 *          one collector config scrapes both emitters identically. Stdout is
 *          never touched (so `--json` output stays clean).
 *
 *   - **Required-metadata gate (067 § 4.2).** Every event MUST carry
 *     `eval.run_id`. An emission missing it is malformed; we drop it (no
 *     throw — the gate is a quality filter on telemetry, not a pipeline halt)
 *     and, when stderr emission is on, print a single `[OTEL-DROP]` diagnostic
 *     so the malformation is observable without crashing the run.
 *
 *   - **Name authority.** Event names + attribute keys come ONLY from
 *     `./names.ts`, which reproduces the 067 spec + kernel YAML verbatim. No
 *     name is spelled inline here.
 */

import { trace, SpanStatusCode, type Span, type Attributes } from "@opentelemetry/api";
import { OtelAttrs, type OtelEventName } from "./names.js";

/** Tracer name + version for the j-rig emitter (OTel instrumentation scope). */
const TRACER_NAME = "@j-rig/core";
const TRACER_VERSION = "2.1.0";

/**
 * Attribute values accepted by an OTel event payload. Mirrors the OTel
 * `Attributes` value space (string | number | boolean | arrays thereof). We
 * additionally accept `null`/`undefined` and strip them, so callers can pass
 * optional fields (e.g. `judge.seed` is `int | null` per 067 § 1.2) without
 * branching at every call site.
 */
export type OtelAttrValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[]
  | null
  | undefined;

export type OtelEventPayload = Record<string, OtelAttrValue>;

/**
 * Is stderr `[OTEL]`-marker emission active? On when `J_RIG_OTEL=1` OR an OTLP
 * endpoint is configured (matching the audit-harness AUDIT_HARNESS_OTEL / OTLP
 * trigger). Evaluated per-call so tests can toggle the env var.
 */
function stderrEmissionActive(): boolean {
  return (
    process.env.J_RIG_OTEL === "1" || (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.length ?? 0) > 0
  );
}

/**
 * Strip null/undefined and coerce the payload to an OTel `Attributes` map.
 * OTel attribute values may not be null/undefined; optional fields are simply
 * omitted from the emitted event.
 */
function toAttributes(payload: OtelEventPayload): Attributes {
  const attrs: Attributes = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined) continue;
    attrs[k] = v;
  }
  return attrs;
}

/**
 * Emit one OTel event. Best-effort: never throws into the caller's pipeline.
 *
 * @param name    A canonical event name from `OtelEvents` (./names.ts).
 * @param payload The event attributes. MUST include `eval.run_id` (067 § 4.2)
 *                or the event is dropped as malformed.
 * @param span    Optional explicit span to attach the event to. When omitted,
 *                the active context's span is used (if any).
 */
export function emitOtelEvent(name: OtelEventName, payload: OtelEventPayload, span?: Span): void {
  try {
    const runId = payload[OtelAttrs.EVAL_RUN_ID];
    if (typeof runId !== "string" || runId.length === 0) {
      // Required-metadata gate (067 § 4.2): an event without eval.run_id is
      // unjoinable to its lineage and is malformed. Drop it; surface a
      // diagnostic only when stderr emission is on. NEVER throw.
      if (stderrEmissionActive()) {
        process.stderr.write(
          `[OTEL-DROP] event '${name}' missing required eval.run_id; dropped (067 § 4.2)\n`,
        );
      }
      return;
    }

    const attrs = toAttributes(payload);

    // Transport 1: real OTel API. A no-op tracer when no provider is
    // registered, so this is genuinely free in the common case.
    const targetSpan = span ?? trace.getActiveSpan();
    if (targetSpan) {
      targetSpan.addEvent(name, attrs);
    } else {
      // No active span: open a short-lived span so the event is still
      // exportable by a configured provider. With no provider this is a no-op
      // span and addEvent/end are no-ops.
      const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
      const s = tracer.startSpan(name);
      s.addEvent(name, attrs);
      s.end();
    }

    // Transport 2: stderr `[OTEL]`-marker JSON line (audit-harness scrape
    // contract). Single line, JSON-escaped, stderr only.
    if (stderrEmissionActive()) {
      const line = JSON.stringify({ name, attributes: attrs });
      process.stderr.write(`[OTEL] ${line}\n`);
    }
  } catch {
    // Best-effort: any failure in telemetry emission (serialization, OTel SDK
    // internals) is swallowed. The eval's own outcome must never depend on
    // whether a collector was reachable (iah-E07c parity).
  }
}

/**
 * Run `fn` inside an OTel span named `name`, emitting span-scoped events from
 * within. The span carries the shared correlation attributes so every nested
 * event pivots back to its EvalRun. Best-effort: when no provider is
 * registered the span is a no-op and `fn` runs unchanged.
 *
 * Records an exception + ERROR status on the span if `fn` throws, then
 * re-throws — telemetry observes the failure but does not swallow it (a thrown
 * eval error is a real pipeline signal, distinct from a swallowed telemetry
 * error).
 */
export async function withEvalSpan<T>(
  name: string,
  correlation: { evalRunId: string; sessionTraceId?: string; traceId?: string },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
  const span = tracer.startSpan(name);
  span.setAttribute(OtelAttrs.EVAL_RUN_ID, correlation.evalRunId);
  if (correlation.sessionTraceId) {
    span.setAttribute(OtelAttrs.EVAL_SESSION_TRACE_ID, correlation.sessionTraceId);
  }
  if (correlation.traceId) {
    span.setAttribute(OtelAttrs.TRACE_ID, correlation.traceId);
  }
  try {
    return await fn(span);
  } catch (err) {
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}
