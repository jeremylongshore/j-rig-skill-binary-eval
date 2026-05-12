/**
 * MM-4 — side-effect verification detector.
 *
 * Spec failure shape: "Operation requires verification of side-effect
 * completion before downstream tools can rely on it."
 *
 * Hook matcher: PostToolUse on the operation, with poll-until-verified
 * (potentially `async` + `asyncRewake`) in the hook handler.
 *
 * OTel signal: claude_code.hook_execution_start followed by
 * claude_code.hook_execution_complete with verified side-effect; downstream
 * tool_decision events parented under the same trace.
 *
 * NOT_APPLICABLE  - no tool_decision with side_effect=true
 * PASS            - every side-effect operation either had a verifying hook
 *                   complete OR no downstream tool ran (nothing depended on
 *                   the unverified state)
 * FAIL            - side-effect operation followed by downstream tool with
 *                   no intervening verifying hook
 */
import type { MMChecker, MMResult, TraceEvent } from "./types.js";

const VERIFY_MARKERS = ["verify", "poll-until-verified", "side-effect-verified"];

export const checkMM4SideEffectVerification: MMChecker = (events: TraceEvent[]): MMResult => {
  const sideEffects = events.filter(
    (e) =>
      e.name === "claude_code.tool_decision" && e.attributes["side_effect"] === true,
  );

  if (sideEffects.length === 0) {
    return {
      category: "MM-4",
      result: "NOT_APPLICABLE",
      reason: "no tool_decision events declare side_effect=true",
    };
  }

  let passes = 0;
  let fails = 0;
  const findings: Array<{ at: string; reason: string }> = [];

  for (const op of sideEffects) {
    const opTime = Date.parse(op.timestamp);
    if (Number.isNaN(opTime)) continue;
    const downstream = events.find(
      (e) =>
        e.name === "claude_code.tool_decision" &&
        e !== op &&
        Date.parse(e.timestamp) > opTime,
    );
    if (!downstream) {
      passes++;
      continue;
    }
    const hi = Date.parse(downstream.timestamp);
    let verified = false;
    for (const e of events) {
      if (e.name !== "claude_code.hook_execution_complete") continue;
      const t = Date.parse(e.timestamp);
      if (t <= opTime || t >= hi) continue;
      const handler = String(
        e.attributes["hook.handler"] ?? e.attributes["hook.action"] ?? "",
      ).toLowerCase();
      if (VERIFY_MARKERS.some((m) => handler.includes(m))) {
        verified = true;
        break;
      }
    }
    if (verified) {
      passes++;
    } else {
      fails++;
      findings.push({
        at: op.timestamp,
        reason: "downstream tool_decision followed without an intervening verification hook",
      });
    }
  }

  if (fails === 0) {
    return {
      category: "MM-4",
      result: "PASS",
      reason: `${passes} side-effect operation(s) properly verified or had no downstream dependent`,
      metadata: { sideEffects: sideEffects.length, passes, fails },
    };
  }
  return {
    category: "MM-4",
    result: "FAIL",
    reason: `${fails} of ${sideEffects.length} side-effect operation(s) lacked verification before downstream use`,
    metadata: { sideEffects: sideEffects.length, passes, fails, findings },
  };
};
