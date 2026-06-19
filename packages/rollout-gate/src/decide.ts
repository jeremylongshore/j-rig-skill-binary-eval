/**
 * Rollout decision logic — consume an Evidence Bundle (gate-result/v1 rows)
 * plus a rollout policy, produce an allow/block decision.
 *
 * FAIL CLOSED everywhere:
 *   - malformed bundle (not a plain array nor a known container) → block
 *   - schema-invalid row → block, citing the row index
 *   - empty bundle → block
 *   - missing required gate → block
 *   - required gate present but not passing → block
 *   - forbidden decision (`fail` / `error` by default) anywhere → block
 *   - invalid policy → block
 *
 * Row validation reuses `@j-rig/core`'s `EvidenceStatementSchema` (which is
 * the kernel `@intentsolutions/core` gate-result/v1 statement schema plus
 * j-rig's secondary cross-field invariants). No schema is re-declared here.
 */
import { EvidenceStatementSchema, type EvidenceStatement, type GateResult } from "@j-rig/core";
import { RolloutPolicySchema, type RolloutPolicy, type RolloutPolicyInput } from "./policy.js";

// ── Bundle parsing (in-memory wire forms) ───────────────────────────────────

/** One row of the input bundle, validated independently. */
export interface ParsedRow {
  /** Index into the source array (plain-array form) or `rows` (container form). */
  index: number;
  /** The validated statement, or null when the row failed schema validation. */
  statement: EvidenceStatement | null;
  /** Validation error message, or null when the row is valid. */
  error: string | null;
}

export interface ParseBundleResult {
  /** Which wire form the input matched. */
  form: "array" | "container" | "malformed";
  /** Container/shape-level error (set only when form === "malformed"). */
  formError: string | null;
  rows: ParsedRow[];
}

/**
 * Parse an in-memory Evidence Bundle. Accepts BOTH supported wire forms:
 *   1. v2 plain array of statements (kernel `EvidenceBundlePayload`)
 *   2. v1 legacy container `{ bundle_format: "json-array", rows: [...] }`
 *
 * Every row is validated independently against `EvidenceStatementSchema`;
 * a malformed row is reported with its index and does not hide sibling rows.
 */
export function parseBundle(input: unknown): ParseBundleResult {
  if (Array.isArray(input)) {
    return { form: "array", formError: null, rows: input.map(validateRow) };
  }

  if (input !== null && typeof input === "object" && "bundle_format" in input) {
    const fmt = (input as { bundle_format?: unknown }).bundle_format;
    if (fmt !== "json-array") {
      return {
        form: "malformed",
        formError: `unknown bundle_format '${String(fmt)}' (expected 'json-array')`,
        rows: [],
      };
    }
    const rows = (input as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) {
      return { form: "malformed", formError: "bundle.rows must be an array", rows: [] };
    }
    return { form: "container", formError: null, rows: rows.map(validateRow) };
  }

  return {
    form: "malformed",
    formError:
      "bundle must be a plain array of gate-result/v1 statements or a " +
      "{ bundle_format: 'json-array', rows: [...] } container",
    rows: [],
  };
}

function validateRow(raw: unknown, index: number): ParsedRow {
  const check = EvidenceStatementSchema.safeParse(raw);
  if (check.success) {
    return { index, statement: check.data, error: null };
  }
  const message = check.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  return { index, statement: null, error: message };
}

// ── Decision ────────────────────────────────────────────────────────────────

export type Decision = "allow" | "block";

export interface EvaluatedRequiredGate {
  /** The policy pattern this entry evaluates. */
  pattern: string;
  /** "pass" = present and all matched rows pass; otherwise blocking. */
  status: "pass" | "missing" | "not-passing";
  /** gate_ids of valid rows matched by this pattern. */
  matched_gate_ids: string[];
}

export interface EvaluatedRow {
  index: number;
  /** null when the row failed schema validation. */
  gate_id: string | null;
  /** null when the row failed schema validation. */
  gate_decision: GateResult | null;
  valid: boolean;
  /** true when this row contributed at least one blocking reason. */
  blocking: boolean;
  reasons: string[];
}

export interface DecideResult {
  decision: Decision;
  /** Every blocking reason found (empty exactly when decision === "allow"). */
  reasons: string[];
  evaluated: {
    required_gates: EvaluatedRequiredGate[];
    rows: EvaluatedRow[];
  };
}

/**
 * Decide whether a rollout is allowed. `allow` requires ALL of:
 *   - well-formed, non-empty bundle with every row schema-valid
 *   - every `required_gates` pattern matched by ≥1 row, all matched rows pass
 *   - zero rows with a forbidden decision (`fail` + `error` by default)
 *   - zero advisory rows when `advisory_blocks` is set
 *   - zero unknown-gate rows when `allow_unknown_gates` is false
 * Anything else blocks, with every contributing reason listed.
 */
export function decide(bundle: unknown, policy: RolloutPolicyInput): DecideResult {
  const reasons: string[] = [];
  const evaluatedRows: EvaluatedRow[] = [];
  const evaluatedRequired: EvaluatedRequiredGate[] = [];

  // Fail closed on a bad policy: never decide against a half-understood policy.
  const policyCheck = RolloutPolicySchema.safeParse(policy);
  if (!policyCheck.success) {
    const message = policyCheck.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    return {
      decision: "block",
      reasons: [`invalid policy: ${message}`],
      evaluated: { required_gates: [], rows: [] },
    };
  }
  const resolved: RolloutPolicy = policyCheck.data;

  const parsed = parseBundle(bundle);
  if (parsed.form === "malformed") {
    return {
      decision: "block",
      reasons: [`malformed bundle: ${parsed.formError ?? "unrecognized shape"}`],
      evaluated: { required_gates: [], rows: [] },
    };
  }

  if (parsed.rows.length === 0) {
    return {
      decision: "block",
      reasons: ["empty bundle: zero gate-result rows — nothing to attest a rollout on"],
      evaluated: { required_gates: [], rows: [] },
    };
  }

  const patterns = resolved.required_gates.map((p) => ({
    pattern: p,
    regex: patternToRegex(p),
  }));
  const forbidden: ReadonlySet<string> = new Set(resolved.forbid_decisions);

  // Per-row evaluation.
  for (const row of parsed.rows) {
    const rowReasons: string[] = [];

    if (row.statement === null) {
      rowReasons.push(`schema-invalid row at index ${row.index}: ${row.error ?? "unknown error"}`);
      evaluatedRows.push({
        index: row.index,
        gate_id: null,
        gate_decision: null,
        valid: false,
        blocking: true,
        reasons: rowReasons,
      });
      reasons.push(...rowReasons);
      continue;
    }

    const gateId = row.statement.predicate.gate_id;
    const gateDecision = row.statement.predicate.gate_decision;

    if (forbidden.has(gateDecision)) {
      rowReasons.push(
        `forbidden decision '${gateDecision}' from gate '${gateId}' at index ${row.index}`,
      );
    }
    if (gateDecision === "advisory" && resolved.advisory_blocks) {
      rowReasons.push(
        `advisory decision from gate '${gateId}' at index ${row.index} blocks (advisory_blocks=true)`,
      );
    }
    const matchesRequired = patterns.some((p) => p.regex.test(gateId));
    if (!matchesRequired && !resolved.allow_unknown_gates) {
      rowReasons.push(
        `unknown gate '${gateId}' at index ${row.index} not allowed (allow_unknown_gates=false)`,
      );
    }

    evaluatedRows.push({
      index: row.index,
      gate_id: gateId,
      gate_decision: gateDecision,
      valid: true,
      blocking: rowReasons.length > 0,
      reasons: rowReasons,
    });
    reasons.push(...rowReasons);
  }

  // Required-gate evaluation (only schema-valid rows can satisfy a requirement).
  for (const { pattern, regex } of patterns) {
    const matched = parsed.rows.filter(
      (r): r is ParsedRow & { statement: EvidenceStatement } =>
        r.statement !== null && regex.test(r.statement.predicate.gate_id),
    );
    const matchedIds = matched.map((r) => r.statement.predicate.gate_id);

    if (matched.length === 0) {
      evaluatedRequired.push({ pattern, status: "missing", matched_gate_ids: [] });
      reasons.push(`required gate '${pattern}' missing from bundle`);
      continue;
    }

    const nonPassing = matched.filter((r) => r.statement.predicate.gate_decision !== "pass");
    if (nonPassing.length > 0) {
      evaluatedRequired.push({ pattern, status: "not-passing", matched_gate_ids: matchedIds });
      reasons.push(
        `required gate '${pattern}' present but not passing ` +
          `(${nonPassing
            .map((r) => `'${r.statement.predicate.gate_id}'=${r.statement.predicate.gate_decision}`)
            .join(", ")})`,
      );
      continue;
    }

    evaluatedRequired.push({ pattern, status: "pass", matched_gate_ids: matchedIds });
  }

  return {
    decision: reasons.length === 0 ? "allow" : "block",
    reasons,
    evaluated: { required_gates: evaluatedRequired, rows: evaluatedRows },
  };
}

/**
 * Convert a required-gate pattern to an anchored regex. `*` matches any run
 * of characters (including `:`); all other characters match literally.
 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}
