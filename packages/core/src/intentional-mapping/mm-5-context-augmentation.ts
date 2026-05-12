/**
 * MM-5 — mandatory context augmentation detector.
 *
 * Spec failure shape: "Tool inputs need to carry mandatory context (caller
 * identity, intent string, policy tag) that the model isn't reliably
 * providing."
 *
 * Hook matcher: PreToolUse with input-augmentation in the hook handler;
 * sets hookSpecificOutput.updatedToolInput.
 *
 * OTel signal: claude_code.hook_execution_complete log event; subsequent
 * claude_code.tool_decision with the augmented inputs visible (under
 * OTEL_LOG_TOOL_DETAILS=1).
 *
 * NOT_APPLICABLE  - no tool_decision events declare requires_context (an
 *                   array of mandatory context keys like ["caller","intent",
 *                   "policy_tag"])
 * PASS            - every requires_context tool decision had all required
 *                   keys present in the final tool_input
 * FAIL            - any requires_context tool decision was missing one or
 *                   more required keys (and no augmentation hook fired
 *                   between the model's emission and the tool decision)
 */
import type { MMChecker, MMResult, TraceEvent } from "./types.js";

const AUGMENT_MARKERS = ["augment", "inject-context", "input-augmentation"];

export const checkMM5ContextAugmentation: MMChecker = (events: TraceEvent[]): MMResult => {
  const decisions = events.filter(
    (e) =>
      e.name === "claude_code.tool_decision" &&
      Array.isArray(e.attributes["requires_context"]),
  );

  if (decisions.length === 0) {
    return {
      category: "MM-5",
      result: "NOT_APPLICABLE",
      reason: "no tool_decision events declare requires_context",
    };
  }

  let passes = 0;
  let fails = 0;
  const findings: Array<{ at: string; missing: string[] }> = [];

  for (const dec of decisions) {
    const required = (dec.attributes["requires_context"] as string[]) ?? [];
    const provided = (dec.attributes["tool_input_keys"] as string[] | undefined) ?? [];
    const missing = required.filter((k) => !provided.includes(k));
    if (missing.length === 0) {
      passes++;
      continue;
    }

    // Did an augmentation hook fire just before this decision?
    const decTime = Date.parse(dec.timestamp);
    const recentAugment = events.find(
      (e) =>
        e.name === "claude_code.hook_execution_complete" &&
        Math.abs(Date.parse(e.timestamp) - decTime) < 5000 &&
        AUGMENT_MARKERS.some((m) =>
          String(e.attributes["hook.handler"] ?? e.attributes["hook.action"] ?? "")
            .toLowerCase()
            .includes(m),
        ),
    );
    if (recentAugment) {
      // Augmentation hook fired — but the tool_input_keys still doesn't include
      // the required key. Treat this as a fail with a different reason.
      fails++;
      findings.push({ at: dec.timestamp, missing });
    } else {
      fails++;
      findings.push({ at: dec.timestamp, missing });
    }
  }

  if (fails === 0) {
    return {
      category: "MM-5",
      result: "PASS",
      reason: `${passes} requires_context decision(s) carried all required keys`,
      metadata: { decisions: decisions.length, passes, fails },
    };
  }
  return {
    category: "MM-5",
    result: "FAIL",
    reason: `${fails} of ${decisions.length} requires_context decision(s) missing required context keys`,
    metadata: { decisions: decisions.length, passes, fails, findings },
  };
};
