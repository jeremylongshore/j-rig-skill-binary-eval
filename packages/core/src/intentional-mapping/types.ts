/**
 * Intentional Mapping (MM) types — the data shapes a behavioral checker
 * consumes and produces.
 *
 * Source: intent-eval-lab/specs/mcp-plugin-observability/v0.1.0-draft/intentional-mapping-template.md
 *
 * The MM categories (MM-1 .. MM-6) are vendor-neutral failure shapes a
 * Claude Code plugin (or any agent-tooling artifact) is expected to be
 * hardened against via its hook bundle. Each category specifies:
 *   1. The failure shape (what goes wrong if no hook addresses it)
 *   2. The hook matcher pattern that addresses it
 *   3. The OTel signal pattern that proves the hook fired
 *
 * j-rig's role is to read a recorded telemetry trace + an Intentional
 * Mapping declaration + emit PASS/FAIL/NOT_APPLICABLE per MM category.
 *
 * For now (Phase 3 of M3), this file pins the shared types. Per-category
 * checkers live in mm-N.ts files and register into the registry.
 */

/** Closed enum of MM categories at v0.1.0-draft of the spec. */
export type MMCategory = "MM-1" | "MM-2" | "MM-3" | "MM-4" | "MM-5" | "MM-6";

/** Pretty labels for human-facing output. */
export const MM_LABELS: Record<MMCategory, string> = {
  "MM-1": "async race",
  "MM-2": "shape drift",
  "MM-3": "cooldown",
  "MM-4": "side-effect verification",
  "MM-5": "context augmentation",
  "MM-6": "strict-mode protocol compliance",
};

/**
 * One OTel-shaped event in a recorded trace. j-rig consumes traces that
 * look like Claude Code's own log events (OTLP-flat JSON), but the checker
 * surface is provider-neutral — the trace consumer only relies on the fields
 * declared here.
 */
export interface TraceEvent {
  /** Event name. Examples: claude_code.tool_decision, claude_code.tool_result, claude_code.hook_execution_start, claude_code.hook_execution_complete. */
  name: string;
  /** Wall-clock time, RFC 3339. Used to order events; precise format MAY vary. */
  timestamp: string;
  /** Free-form attribute bag. Common keys: tool, server, decision, hook.matcher, etc. */
  attributes: Record<string, unknown>;
  /** Optional trace id grouping multiple events into the same logical operation. */
  traceId?: string;
  /** Optional parent event id for span-style nesting. */
  parentId?: string;
  /** Optional event id (used by parentId references). */
  id?: string;
}

/**
 * A recorded fixture trace + the declared MM coverage being asserted against
 * it. Fixtures live under packages/core/fixtures/mm-traces/MM-N/<name>.json.
 */
export interface MMFixture {
  /** Human-friendly name; used in test output. */
  name: string;
  /** The MM category this fixture exercises. */
  category: MMCategory;
  /** What the checker should conclude when run against this trace. */
  expected: MMResult["result"];
  /** Optional notes for the fixture author / future readers. */
  notes?: string;
  /** Trace events in chronological order. */
  events: TraceEvent[];
}

/** Result of running a checker against a trace. */
export interface MMResult {
  category: MMCategory;
  result: "PASS" | "FAIL" | "NOT_APPLICABLE";
  /** Human-readable explanation suitable for both stderr and metadata. */
  reason: string;
  /** Structured findings (for piping into emit-evidence metadata). */
  metadata?: Record<string, unknown>;
}

/**
 * Signature of a checker function. Pure — given the same trace, returns the
 * same result. Side-effect-free: must not perform IO or external calls.
 */
export type MMChecker = (events: TraceEvent[]) => MMResult;
