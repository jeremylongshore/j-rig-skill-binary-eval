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
  // Pre-parse timestamps ONCE to avoid O(N²) Date.parse calls inside hookBetween.
  // NaN values mean an unparseable timestamp — those events are pinned to -1
  // and treated as "outside any interval", which is the conservative read.
  const eventTimes = events.map((e) => {
    const t = Date.parse(e.timestamp);
    return Number.isNaN(t) ? -1 : t;
  });

  const reads = events
    .map((e, idx) => ({ e, idx, t: eventTimes[idx] }))
    .filter(
      ({ e, t }) =>
        e.name === "claude_code.tool_result" &&
        (e.attributes["tool.kind"] === "read" ||
          typeof e.attributes["response_shape"] === "string") &&
        t !== -1,
    )
    .sort((a, b) => a.t - b.t)
    .map(({ e, idx }) => ({ e, idx }));

  if (reads.length < 2) {
    return {
      category: "MM-2",
      result: "NOT_APPLICABLE",
      reason: "fewer than two read-side tool_result events; shape drift cannot manifest",
    };
  }

  // Group by server.
  const byServer = new Map<string, { e: TraceEvent; idx: number }[]>();
  for (const r of reads) {
    const server = (r.e.attributes.server as string | undefined) ?? "<unknown>";
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
      const prevShape = (prev.e.attributes.response_shape as string | undefined) ?? null;
      const currShape = (curr.e.attributes.response_shape as string | undefined) ?? null;
      if (prevShape === null || currShape === null) continue;
      if (prevShape === currShape) continue;
      const normalized = hookBetween(events, eventTimes, prev.idx, curr.idx, NORMALIZATION_MARKERS);
      if (!normalized) {
        fails++;
        findings.push({
          at: curr.e.timestamp,
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
  eventTimes: number[],
  beforeIdx: number,
  afterIdx: number,
  markers: string[],
): boolean {
  const lo = eventTimes[beforeIdx];
  const hi = eventTimes[afterIdx];
  if (lo === -1 || hi === -1) return false;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.name !== "claude_code.hook_execution_complete") continue;
    const t = eventTimes[i];
    if (t === -1 || t <= lo || t >= hi) continue;
    const handler = String(
      e.attributes["hook.handler"] ?? e.attributes["hook.action"] ?? "",
    ).toLowerCase();
    if (markers.some((m) => handler.includes(m))) return true;
  }
  return false;
}
