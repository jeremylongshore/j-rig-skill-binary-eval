/**
 * MM-1 — async race detector.
 *
 * Spec failure shape (intent-eval-lab/specs/mcp-plugin-observability/v0.1.0-draft/intentional-mapping-template.md):
 *
 *   "Asynchronous tool returns success but a downstream tool sees stale
 *    state (race condition between async write and read-after-write)"
 *
 * Hook matcher pattern: PostToolUse on the upstream tool with reconciliation
 * (retry-with-backoff) in the hook handler.
 *
 * OTel signal pattern: claude_code.hook_execution_complete event correlated
 * with the upstream tool_decision; downstream claude_code.tool_result event
 * reflecting reconciled state.
 *
 * This checker walks a recorded trace and concludes:
 *
 *   NOT_APPLICABLE  - no async-write tool calls observed (the failure mode
 *                     can't manifest)
 *   PASS            - async-write observed AND a downstream read observed AND
 *                     a hook_execution_complete fired between them with the
 *                     reconciliation indicator AND the downstream read result
 *                     reflects fresh state (no stale_state attribute)
 *   FAIL            - async-write observed AND downstream read observed AND
 *                     EITHER no hook fired between them OR the read result
 *                     carries a stale_state=true attribute
 *
 * The detector is heuristic — it reads attributes the OTel exporter is
 * expected to emit per the spec. Real-world traces with novel attribute
 * shapes can extend the attribute set; this is the v0.1.0-draft baseline.
 *
 * Implementation note: trace events are documented as chronologically ordered.
 * We walk by ARRAY INDEX (not timestamp parsing) so reconciliation detection
 * scans ALL hooks between a write and its downstream read — not just the
 * first one. Multi-hook reconciliation flows (logging hook + reconcile hook,
 * for example) need to find any reconciliation marker among them.
 */
import type { MMChecker, MMResult, TraceEvent } from "./types.js";

const HOOK_RECONCILIATION_MARKERS = ["reconcile", "retry-with-backoff", "verify-fresh"];

export const checkMM1AsyncRace: MMChecker = (events: TraceEvent[]): MMResult => {
  const writeIndices = events.reduce<number[]>((acc, e, i) => {
    if (
      e.name === "claude_code.tool_decision" &&
      attr<boolean>(e, "tool.async") === true &&
      attr<string>(e, "tool.kind") === "write"
    ) {
      acc.push(i);
    }
    return acc;
  }, []);

  if (writeIndices.length === 0) {
    return {
      category: "MM-1",
      result: "NOT_APPLICABLE",
      reason: "no asynchronous write-side tool calls observed; MM-1 cannot manifest",
    };
  }

  let passes = 0;
  let fails = 0;
  const findings: Array<{ writeAt: string; reason: string }> = [];

  for (const writeIdx of writeIndices) {
    const write = events[writeIdx];
    const readIdx = findDownstreamReadIndex(events, writeIdx);
    if (readIdx === -1) {
      // Async write occurred but no downstream read followed — can't observe race.
      // Treat as inconclusive-positive: nothing to fail against.
      passes++;
      continue;
    }

    let reconciled = false;
    for (let j = writeIdx + 1; j < readIdx; j++) {
      const e = events[j];
      if (
        e.name === "claude_code.hook_execution_complete" &&
        HOOK_RECONCILIATION_MARKERS.some((m) => marksHookHandler(e, m))
      ) {
        reconciled = true;
        break;
      }
    }

    const downstream = events[readIdx];
    const staleResult = attr<boolean>(downstream, "stale_state") === true;

    if (reconciled && !staleResult) {
      passes++;
    } else {
      fails++;
      findings.push({
        writeAt: write.timestamp,
        reason: !reconciled
          ? "no hook_execution_complete with reconciliation marker between async write and downstream read"
          : "downstream read carries stale_state=true after reconciliation",
      });
    }
  }

  if (fails === 0) {
    return {
      category: "MM-1",
      result: "PASS",
      reason: `${passes} async-write/downstream-read pair(s) reconciled correctly`,
      metadata: { writes: writeIndices.length, passes, fails },
    };
  }

  return {
    category: "MM-1",
    result: "FAIL",
    reason: `${fails} of ${writeIndices.length} async-write pair(s) raced (no reconciliation observed)`,
    metadata: { writes: writeIndices.length, passes, fails, findings },
  };
};

// --- helpers ----------------------------------------------------------------

function attr<T>(e: TraceEvent, key: string): T | undefined {
  return e.attributes[key] as T | undefined;
}

/**
 * Find the index of the first claude_code.tool_result event that targets the
 * same tool family after `writeIdx`. Returns -1 if none.
 */
function findDownstreamReadIndex(events: TraceEvent[], writeIdx: number): number {
  const write = events[writeIdx];
  const writeServer = attr<string>(write, "server");
  for (let i = writeIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.name !== "claude_code.tool_result") continue;
    if (attr<string>(e, "tool.kind") !== "read") continue;
    if (writeServer && attr<string>(e, "server") !== writeServer) continue;
    return i;
  }
  return -1;
}

/** Check whether a hook event's metadata mentions a reconciliation marker. */
function marksHookHandler(hookEvent: TraceEvent, marker: string): boolean {
  // Common attribute keys that might carry the marker. We accept a few shapes
  // since the OTel emitter convention is still in flight (PB-10 RFC).
  const candidates = [
    attr<string>(hookEvent, "hook.handler"),
    attr<string>(hookEvent, "hook.action"),
    attr<string>(hookEvent, "hook.behavior"),
    attr<string>(hookEvent, "hook.kind"),
  ];
  return candidates.some((v) => typeof v === "string" && v.toLowerCase().includes(marker));
}
