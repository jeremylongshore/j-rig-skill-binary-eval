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
 *
 * Implementation note: events are documented chronological. We pre-index by
 * array position and pre-parse timestamps once. The downstream-decision
 * search is then linear forward-scan from the operation's index — O(N) per
 * operation, O(N·S) overall instead of O(S·N) with quadratic Date.parse.
 */
import type { MMChecker, MMResult, TraceEvent } from "./types.js";

const VERIFY_MARKERS = ["verify", "poll-until-verified", "side-effect-verified"];

export const checkMM4SideEffectVerification: MMChecker = (events: TraceEvent[]): MMResult => {
  const eventTimes = events.map((e) => {
    const t = Date.parse(e.timestamp);
    return Number.isNaN(t) ? -1 : t;
  });

  const sideEffectIndices: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (
      e.name === "claude_code.tool_decision" &&
      e.attributes["side_effect"] === true &&
      eventTimes[i] !== -1
    ) {
      sideEffectIndices.push(i);
    }
  }

  if (sideEffectIndices.length === 0) {
    return {
      category: "MM-4",
      result: "NOT_APPLICABLE",
      reason: "no tool_decision events declare side_effect=true",
    };
  }

  let passes = 0;
  let fails = 0;
  const findings: Array<{ at: string; reason: string }> = [];

  for (const opIdx of sideEffectIndices) {
    const op = events[opIdx];
    const opTime = eventTimes[opIdx];

    // Forward-scan from opIdx+1 for the first downstream tool_decision.
    let downstreamIdx = -1;
    for (let j = opIdx + 1; j < events.length; j++) {
      if (
        events[j].name === "claude_code.tool_decision" &&
        eventTimes[j] !== -1 &&
        eventTimes[j] > opTime
      ) {
        downstreamIdx = j;
        break;
      }
    }

    if (downstreamIdx === -1) {
      passes++;
      continue;
    }
    const hi = eventTimes[downstreamIdx];

    let verified = false;
    for (let k = opIdx + 1; k < downstreamIdx; k++) {
      const e = events[k];
      if (e.name !== "claude_code.hook_execution_complete") continue;
      const t = eventTimes[k];
      if (t === -1 || t <= opTime || t >= hi) continue;
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
      metadata: { sideEffects: sideEffectIndices.length, passes, fails },
    };
  }
  return {
    category: "MM-4",
    result: "FAIL",
    reason: `${fails} of ${sideEffectIndices.length} side-effect operation(s) lacked verification before downstream use`,
    metadata: { sideEffects: sideEffectIndices.length, passes, fails, findings },
  };
};
