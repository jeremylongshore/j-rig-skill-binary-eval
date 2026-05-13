/**
 * MM-3 — cooldown / debouncing detector.
 *
 * Spec failure shape: "Operation requires a cooldown / debouncing window
 * before the next equivalent operation can succeed."
 *
 * Hook matcher: PreToolUse on the affected tool, with cooldown-enforcement
 * (block + retry-after) in the hook handler.
 *
 * OTel signal: claude_code.hook_execution_complete with handler-emitted
 * decision: block semantics; claude_code.tool_decision showing the retry
 * attempt at or after the cooldown window.
 *
 * NOT_APPLICABLE  - no tool sequence with declared cooldown_ms attribute
 * PASS            - all attempts inside the cooldown window were either
 *                   blocked by a pre-tool hook OR delayed by ≥ cooldown_ms
 * FAIL            - an attempt fired inside the cooldown window without a
 *                   blocking pre-tool hook intervening
 */
import type { MMChecker, MMResult, TraceEvent } from "./types.js";

export const checkMM3Cooldown: MMChecker = (events: TraceEvent[]): MMResult => {
  // Find tool_decision events that declare a cooldown_ms.
  const decisions = events
    .filter(
      (e) =>
        e.name === "claude_code.tool_decision" &&
        typeof e.attributes["cooldown_ms"] === "number",
    )
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  if (decisions.length === 0) {
    return {
      category: "MM-3",
      result: "NOT_APPLICABLE",
      reason: "no tool_decision events declare a cooldown_ms; MM-3 cannot manifest",
    };
  }

  // Group by tool identity (server + tool).
  const byTool = new Map<string, TraceEvent[]>();
  for (const d of decisions) {
    const key = `${d.attributes.server ?? "<server>"}:${d.attributes.tool ?? "<tool>"}`;
    if (!byTool.has(key)) byTool.set(key, []);
    byTool.get(key)!.push(d);
  }

  let pairs = 0;
  let fails = 0;
  const findings: Array<{ at: string; reason: string }> = [];

  for (const seq of byTool.values()) {
    for (let i = 1; i < seq.length; i++) {
      pairs++;
      const prev = seq[i - 1];
      const curr = seq[i];
      const prevTime = Date.parse(prev.timestamp);
      const currTime = Date.parse(curr.timestamp);
      const cooldownMs = Number(prev.attributes.cooldown_ms);
      if (Number.isNaN(prevTime) || Number.isNaN(currTime) || Number.isNaN(cooldownMs)) continue;
      const elapsed = currTime - prevTime;
      if (elapsed >= cooldownMs) continue; // cooldown honored by delay
      // Was a blocking pre-tool hook fired between prev and curr?
      const blocked = blockingHookBetween(events, prev, curr);
      if (!blocked) {
        fails++;
        findings.push({
          at: curr.timestamp,
          reason: `attempt at ${currTime - prevTime}ms after prior attempt < cooldown of ${cooldownMs}ms with no blocking hook`,
        });
      }
    }
  }

  if (pairs === 0) {
    return {
      category: "MM-3",
      result: "NOT_APPLICABLE",
      reason: "no repeat tool decisions on the same tool to inspect",
    };
  }

  if (fails === 0) {
    return {
      category: "MM-3",
      result: "PASS",
      reason: `${pairs} repeat-decision pair(s) inspected; cooldown honored or hook-blocked`,
      metadata: { pairs, fails },
    };
  }
  return {
    category: "MM-3",
    result: "FAIL",
    reason: `${fails} of ${pairs} repeat pair(s) violated cooldown without a blocking hook`,
    metadata: { pairs, fails, findings },
  };
};

function blockingHookBetween(
  events: TraceEvent[],
  before: TraceEvent,
  after: TraceEvent,
): boolean {
  const lo = Date.parse(before.timestamp);
  const hi = Date.parse(after.timestamp);
  if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
  for (const e of events) {
    if (e.name !== "claude_code.hook_execution_complete") continue;
    const t = Date.parse(e.timestamp);
    if (t <= lo || t > hi) continue;
    const decision = String(e.attributes["decision"] ?? "").toLowerCase();
    if (decision === "block") return true;
  }
  return false;
}
