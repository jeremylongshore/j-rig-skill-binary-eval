/**
 * PR-comment renderer — turn a rollout-gate decision into a stable, idempotent
 * markdown comment block.
 *
 * IDEMPOTENCE MODEL
 * -----------------
 * The renderer wraps every comment body between a hidden HTML-comment marker
 * pair:
 *
 *   <!-- j-rig-rollout-gate:<key> -->
 *   ...rendered body...
 *   <!-- /j-rig-rollout-gate:<key> -->
 *
 * The host (a GitHub Action) lists existing PR comments, finds the one whose
 * body contains the OPENING marker for the same `key` (see {@link hasMarker} /
 * {@link findCommentWithMarker}), and PATCHes that comment instead of creating a
 * new one. Re-running the gate therefore UPDATES the single existing comment
 * rather than appending a duplicate on every push.
 *
 * The marker is an HTML comment so it never renders visibly on GitHub. The
 * `key` lets several independent gates (e.g. one per eval pack) each own their
 * own comment on the same PR without colliding.
 *
 * This module is a PURE FUNCTION LIBRARY: no network, no filesystem, no clock,
 * no process state. The same input always renders byte-identical output, which
 * is what makes "did the comment change?" cheap to answer (compare the rendered
 * body to the existing one and skip the PATCH when equal).
 */

/** A single forbidden / required gate row, as evaluated by the rollout gate. */
export interface RenderRow {
  /** Index into the source bundle (kept for traceability). */
  index: number;
  /** Pipeline-hop-qualified gate id, or null when the row failed schema parse. */
  gate_id: string | null;
  /** Lowercase gate decision, or null when the row failed schema parse. */
  gate_decision: "pass" | "fail" | "advisory" | "error" | null;
  /** Whether the row contributed at least one blocking reason. */
  blocking: boolean;
  /** Blocking reasons attributable to this row (empty when non-blocking). */
  reasons: string[];
}

/** A required-gate-pattern evaluation, as produced by the rollout gate. */
export interface RenderRequiredGate {
  /** The policy pattern this entry evaluated. */
  pattern: string;
  /** Whether the pattern was satisfied, missing, or matched-but-not-passing. */
  status: "pass" | "missing" | "not-passing";
  /** gate_ids of the valid rows this pattern matched. */
  matched_gate_ids: string[];
}

/**
 * The decision shape the renderer consumes. This is structurally compatible
 * with `DecideResult` from `@intentsolutions/rollout-gate` — we accept the
 * minimal shape rather than importing the package so the renderer carries no
 * runtime dependency.
 */
export interface RenderableDecision {
  /** `"allow"` ⇒ rollout permitted; `"block"` ⇒ rollout refused. */
  decision: "allow" | "block";
  /** Every blocking reason found (empty exactly when decision === "allow"). */
  reasons: string[];
  evaluated: {
    required_gates: RenderRequiredGate[];
    rows: RenderRow[];
  };
}

export interface RenderOptions {
  /**
   * Marker key. Distinct keys own distinct comments on the same PR. Must match
   * `[a-z0-9][a-z0-9._-]*` so it is safe inside the HTML-comment marker.
   * Default: `"default"`.
   */
  key?: string;
  /**
   * Optional H2 title prefix shown above the verdict line. Default:
   * `"Rollout Gate"`.
   */
  title?: string;
  /**
   * Optional permalink to the run / evidence bundle, rendered as a footer
   * line when present. No link is rendered when omitted.
   */
  detailsUrl?: string;
  /**
   * Cap on how many evaluated rows are listed in the detail table before the
   * output is truncated with a "…and N more" note. Default: 50. Must be ≥ 1.
   */
  maxRows?: number;
}

const MARKER_PREFIX = "j-rig-rollout-gate";
const KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Build the opening marker line for a given key. */
export function openMarker(key = "default"): string {
  return `<!-- ${MARKER_PREFIX}:${normalizeKey(key)} -->`;
}

/** Build the closing marker line for a given key. */
export function closeMarker(key = "default"): string {
  return `<!-- /${MARKER_PREFIX}:${normalizeKey(key)} -->`;
}

/**
 * True when `body` already contains the OPENING marker for `key`. The host
 * uses this to decide PATCH-existing vs CREATE-new.
 */
export function hasMarker(body: string, key = "default"): boolean {
  return body.includes(openMarker(key));
}

/**
 * Find the first comment whose body carries the opening marker for `key`.
 * Returns the matched comment (so the caller can PATCH it by id), or null.
 */
export function findCommentWithMarker<T extends { body?: string | null }>(
  comments: readonly T[],
  key = "default",
): T | null {
  const marker = openMarker(key);
  for (const c of comments) {
    if (typeof c.body === "string" && c.body.includes(marker)) return c;
  }
  return null;
}

function normalizeKey(key: string): string {
  if (!KEY_RE.test(key)) {
    throw new Error(`pr-comment: invalid marker key '${key}' — must match ${KEY_RE.source}`);
  }
  return key;
}

/**
 * Render a rollout-gate decision as an idempotent, marker-anchored markdown
 * comment body.
 *
 * The output is deterministic for a given (decision, options) pair: identical
 * input renders byte-identical output, so the host can skip the API call when
 * the rendered body equals the existing comment body.
 */
export function renderPrComment(decision: RenderableDecision, options: RenderOptions = {}): string {
  const key = normalizeKey(options.key ?? "default");
  const title = (options.title ?? "Rollout Gate").trim() || "Rollout Gate";
  const maxRows = normalizeMaxRows(options.maxRows);

  const lines: string[] = [];
  lines.push(openMarker(key));
  lines.push(`## ${title} — ${verdictLabel(decision.decision)}`);
  lines.push("");
  lines.push(summaryLine(decision));
  lines.push("");

  const blockingReasons = decision.reasons;
  if (decision.decision === "block" && blockingReasons.length > 0) {
    lines.push("### Why blocked");
    lines.push("");
    for (const reason of blockingReasons) {
      lines.push(`- ${escapeInline(reason)}`);
    }
    lines.push("");
  }

  const required = decision.evaluated.required_gates;
  if (required.length > 0) {
    lines.push("### Required gates");
    lines.push("");
    lines.push("| Pattern | Status | Matched |");
    lines.push("| --- | --- | --- |");
    for (const rg of required) {
      const matched =
        rg.matched_gate_ids.length > 0 ? rg.matched_gate_ids.map(code).join(", ") : "—";
      lines.push(`| ${code(rg.pattern)} | ${requiredStatusLabel(rg.status)} | ${matched} |`);
    }
    lines.push("");
  }

  const rows = decision.evaluated.rows;
  if (rows.length > 0) {
    lines.push("### Evidence rows");
    lines.push("");
    lines.push("| # | Gate | Decision | Result |");
    lines.push("| --- | --- | --- | --- |");
    const shown = rows.slice(0, maxRows);
    for (const row of shown) {
      lines.push(
        `| ${row.index} | ${row.gate_id === null ? "_(invalid)_" : code(row.gate_id)} ` +
          `| ${decisionLabel(row.gate_decision)} | ${rowResultLabel(row)} |`,
      );
    }
    if (rows.length > shown.length) {
      lines.push(`| | | | …and ${rows.length - shown.length} more |`);
    }
    lines.push("");
  }

  if (options.detailsUrl !== undefined && options.detailsUrl.trim() !== "") {
    lines.push(`[View full evidence bundle](${options.detailsUrl.trim()})`);
    lines.push("");
  }

  lines.push(
    "<sub>Rendered by j-rig rollout gate. This comment updates in place on each run.</sub>",
  );
  lines.push(closeMarker(key));

  return lines.join("\n") + "\n";
}

function normalizeMaxRows(maxRows: number | undefined): number {
  if (maxRows === undefined) return 50;
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error(`pr-comment: maxRows must be an integer ≥ 1 (got ${maxRows})`);
  }
  return maxRows;
}

function verdictLabel(decision: "allow" | "block"): string {
  return decision === "allow" ? "✅ ALLOW" : "🚫 BLOCK";
}

function summaryLine(decision: RenderableDecision): string {
  const total = decision.evaluated.rows.length;
  const blocking = decision.evaluated.rows.filter((r) => r.blocking).length;
  const invalid = decision.evaluated.rows.filter((r) => r.gate_id === null).length;
  if (decision.decision === "allow") {
    return `All gates satisfied across **${total}** evidence row${plural(total)}. Rollout permitted.`;
  }
  return (
    `Rollout blocked: **${blocking}** of **${total}** row${plural(total)} blocking` +
    (invalid > 0 ? ` (${invalid} schema-invalid)` : "") +
    `, **${decision.reasons.length}** reason${plural(decision.reasons.length)}.`
  );
}

function requiredStatusLabel(status: RenderRequiredGate["status"]): string {
  switch (status) {
    case "pass":
      return "✅ pass";
    case "missing":
      return "🚫 missing";
    case "not-passing":
      return "🚫 not passing";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function decisionLabel(decision: RenderRow["gate_decision"]): string {
  switch (decision) {
    case "pass":
      return "✅ pass";
    case "fail":
      return "❌ fail";
    case "advisory":
      return "⚠️ advisory";
    case "error":
      return "🛑 error";
    case null:
      return "— invalid";
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

function rowResultLabel(row: RenderRow): string {
  if (!row.blocking) return "ok";
  if (row.reasons.length === 0) return "blocking";
  return row.reasons.map(escapeInline).join("; ");
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** Wrap a token in inline code, escaping backticks so it can't break out. */
function code(text: string): string {
  return "`" + text.replace(/`/g, "ˋ") + "`";
}

/**
 * Escape markdown so free-form reason text cannot break the table or inject
 * markup. Pipes (table cell separators) and backslashes are the load-bearing
 * escapes; newlines collapse to spaces.
 */
function escapeInline(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
