/**
 * MM-2 — shape-drift detector.
 *
 * Spec failure shape: "Tool's read-side response shape drifts across
 * consecutive calls (e.g., list-shape vs detail-shape inconsistency)".
 *
 * Hook matcher: PostToolUse on the read-side tools, with shape-normalization
 * in the hook handler.
 *
 * OTel signal: claude_code.tool_result events for both the list-shape and
 * detail-shape tools, with parity asserted via tool_input_size_bytes and
 * (with OTEL_LOG_TOOL_CONTENT=1) the content shape signature.
 *
 * NOT_APPLICABLE  - fewer than two consecutive read-side tool_result events
 *                   on the same server (drift cannot manifest)
 * PASS            - a normalization hook fired between read pairs that
 *                   would have drifted, OR no drift observed
 * FAIL            - drift observed (response_shape attribute changed across
 *                   consecutive reads on same server) without a normalization
 *                   hook between them
 */
import type { MMChecker, MMResult, TraceEvent } from "./types.js";

const NORMALIZATION_MARKERS = ["normalize", "shape-fix", "shape-normalization"];

export const checkMM2ShapeDrift: MMChecker = (events: TraceEvent[]): MMResult => {
  const reads = events
    .filter(
      (e) =>
        e.name === "claude_code.tool_result" &&
        (e.attributes["tool.kind"] === "read" ||
          typeof e.attributes["response_shape"] === "string"),
    )
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  if (reads.length < 2) {
    return {
      category: "MM-2",
      result: "NOT_APPLICABLE",
      reason: "fewer than two read-side tool_result events; shape drift cannot manifest",
    };
  }

  // Group by server.
  const byServer = new Map<string, TraceEvent[]>();
  for (const r of reads) {
    const server = (r.attributes.server as string | undefined) ?? "<unknown>";
    if (!byServer.has(server)) byServer.set(server, []);
    byServer.get(server)!.push(r);
  }

  let pairs = 0;
  let fails = 0;
  const findings: Array<{ at: string; reason: string }> = [];

  for (const group of byServer.values()) {
    for (let i = 1; i < group.length; i++) {
      pairs++;
      const prev = group[i - 1];
      const curr = group[i];
      const prevShape = (prev.attributes.response_shape as string | undefined) ?? null;
      const currShape = (curr.attributes.response_shape as string | undefined) ?? null;
      if (prevShape === null || currShape === null) continue;
      if (prevShape === currShape) continue;
      const normalized = hookBetween(events, prev, curr, NORMALIZATION_MARKERS);
      if (!normalized) {
        fails++;
        findings.push({
          at: curr.timestamp,
          reason: `response_shape changed (${prevShape} → ${currShape}) without a normalization hook`,
        });
      }
    }
  }

  if (pairs === 0) {
    return {
      category: "MM-2",
      result: "NOT_APPLICABLE",
      reason: "no consecutive same-server read pairs to compare",
    };
  }

  if (fails === 0) {
    return {
      category: "MM-2",
      result: "PASS",
      reason: `${pairs} read-pair(s) inspected; no unaccounted shape drift`,
      metadata: { pairs, fails },
    };
  }

  return {
    category: "MM-2",
    result: "FAIL",
    reason: `${fails} of ${pairs} read-pair(s) drifted without normalization`,
    metadata: { pairs, fails, findings },
  };
};

function hookBetween(
  events: TraceEvent[],
  before: TraceEvent,
  after: TraceEvent,
  markers: string[],
): boolean {
  const lo = Date.parse(before.timestamp);
  const hi = Date.parse(after.timestamp);
  if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
  for (const e of events) {
    if (e.name !== "claude_code.hook_execution_complete") continue;
    const t = Date.parse(e.timestamp);
    if (t <= lo || t >= hi) continue;
    const handler = String(
      e.attributes["hook.handler"] ?? e.attributes["hook.action"] ?? "",
    ).toLowerCase();
    if (markers.some((m) => handler.includes(m))) return true;
  }
  return false;
}
