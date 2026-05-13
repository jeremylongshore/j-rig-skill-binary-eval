/**
 * MM-6 — strict-mode protocol compliance detector.
 *
 * Spec failure shape: "Server-side endpoint requires strict-mode protocol
 * (W3C, RFC) compliance that the model's default tool input doesn't enforce."
 *
 * Hook matcher: PreToolUse on the affected tool, with strict-mode payload
 * reformat in the hook handler.
 *
 * OTel signal: claude_code.hook_execution_complete log event; subsequent
 * claude_code.tool_result showing the server accepted the call.
 *
 * NOT_APPLICABLE  - no tool_decision events declare strict_mode=true
 * PASS            - every strict_mode call had a reformat hook + a successful
 *                   tool_result
 * FAIL            - a strict_mode call did NOT have a reformat hook OR the
 *                   subsequent tool_result indicates server rejection
 */
import type { MMChecker, MMResult, TraceEvent } from "./types.js";

const REFORMAT_MARKERS = ["reformat", "strict-mode", "rfc-normalize", "w3c-normalize"];

export const checkMM6StrictModeProtocol: MMChecker = (events: TraceEvent[]): MMResult => {
  const strictDecisions = events.filter(
    (e) =>
      e.name === "claude_code.tool_decision" && e.attributes["strict_mode"] === true,
  );

  if (strictDecisions.length === 0) {
    return {
      category: "MM-6",
      result: "NOT_APPLICABLE",
      reason: "no tool_decision events declare strict_mode=true",
    };
  }

  let passes = 0;
  let fails = 0;
  const findings: Array<{ at: string; reason: string }> = [];

  for (const dec of strictDecisions) {
    const decTime = Date.parse(dec.timestamp);

    // Reformat hook should fire shortly before the decision.
    const reformat = events.find(
      (e) =>
        e.name === "claude_code.hook_execution_complete" &&
        Date.parse(e.timestamp) < decTime &&
        decTime - Date.parse(e.timestamp) < 10_000 &&
        REFORMAT_MARKERS.some((m) =>
          String(e.attributes["hook.handler"] ?? e.attributes["hook.action"] ?? "")
            .toLowerCase()
            .includes(m),
        ),
    );

    // Find the result for this decision (next tool_result on the same tool).
    const result = events.find(
      (e) =>
        e.name === "claude_code.tool_result" &&
        Date.parse(e.timestamp) > decTime &&
        e.attributes["tool"] === dec.attributes["tool"],
    );

    const accepted = result && result.attributes["server_response_status"] !== "rejected";

    if (reformat && accepted) {
      passes++;
    } else {
      fails++;
      findings.push({
        at: dec.timestamp,
        reason: !reformat
          ? "no strict-mode reformat hook fired before decision"
          : "server rejected the call",
      });
    }
  }

  if (fails === 0) {
    return {
      category: "MM-6",
      result: "PASS",
      reason: `${passes} strict_mode decision(s) reformatted + accepted by server`,
      metadata: { strictDecisions: strictDecisions.length, passes, fails },
    };
  }
  return {
    category: "MM-6",
    result: "FAIL",
    reason: `${fails} of ${strictDecisions.length} strict_mode decision(s) failed compliance`,
    metadata: { strictDecisions: strictDecisions.length, passes, fails, findings },
  };
};
