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
      e.name === "claude_code.tool_decision" && Array.isArray(e.attributes["requires_context"]),
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
  const findings: Array<{ at: string; missing: string[]; hookAttempted: boolean }> = [];

  for (const dec of decisions) {
    const required = Array.isArray(dec.attributes["requires_context"])
      ? (dec.attributes["requires_context"] as string[])
      : [];
    const provided = Array.isArray(dec.attributes["tool_input_keys"])
      ? (dec.attributes["tool_input_keys"] as string[])
      : [];
    const missing = required.filter((k) => !provided.includes(k));
    if (missing.length === 0) {
      passes++;
      continue;
    }

    // Did an augmentation hook fire just BEFORE this decision? The hook must
    // strictly precede the decision — a hook firing after the decision can't
    // affect the decision's tool_input. We use a 5-second window: hookTime in
    // [decTime - 5000, decTime).
    const decTime = Date.parse(dec.timestamp);
    const recentAugment = Number.isNaN(decTime)
      ? undefined
      : events.find((e) => {
          if (e.name !== "claude_code.hook_execution_complete") return false;
          const t = Date.parse(e.timestamp);
          if (Number.isNaN(t)) return false;
          const delta = decTime - t;
          if (delta <= 0 || delta >= 5000) return false;
          return AUGMENT_MARKERS.some((m) =>
            String(e.attributes["hook.handler"] ?? e.attributes["hook.action"] ?? "")
              .toLowerCase()
              .includes(m),
          );
        });
    if (recentAugment) {
      // Augmentation hook fired — but the tool_input_keys still doesn't include
      // the required key. The hook failed to add it; finding records the
      // distinction so callers can route triage differently.
      fails++;
      findings.push({
        at: dec.timestamp,
        missing,
        hookAttempted: true,
      } as { at: string; missing: string[]; hookAttempted: boolean });
    } else {
      fails++;
      findings.push({
        at: dec.timestamp,
        missing,
        hookAttempted: false,
      } as { at: string; missing: string[]; hookAttempted: boolean });
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
