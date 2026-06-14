/**
 * Evidence Bundle codemod — rewrite v0.1.0-draft predicate bodies into the
 * v2.0 kernel `gate-result/v1` shape (DR-018, iaj-E02 / iaj-migrate-codemod).
 *
 * The migration follows MIGRATION.md verbatim:
 *
 *   | v1 field   | v2 field        | transform                                   |
 *   |------------|-----------------|---------------------------------------------|
 *   | result     | gate_decision   | PASS→pass, FAIL→fail, ADVISORY→advisory;    |
 *   |            |                 | NOT_APPLICABLE → routed via coverage         |
 *   | timestamp  | evaluated_at    | RENAME only (value unchanged)               |
 *   | _(new)_    | gate_name       | DERIVED from gate_id's 3rd segment (lc'd)   |
 *   | _(new)_    | gate_version    | DERIVED from runner's @semver, else 0.0.0   |
 *   | _(new)_    | gate_reasons    | [] (or NOT_APPLICABLE routing reason)       |
 *   | _(new)_    | coverage        | { dimensions_evaluated: [], skipped: [] }   |
 *   | _(new)_    | policy_ref      | sha256:<policy_hash-hex>:unknown             |
 *
 * `NOT_APPLICABLE` routing (DR-018 §279): the value is no longer a decision.
 * A v1 row with `result: "NOT_APPLICABLE"` becomes `gate_decision: "pass"` with
 * the reserved token `"__not_applicable__"` in `coverage.dimensions_skipped`
 * and a self-describing reason appended to `gate_reasons`.
 *
 * The codemod is PURE: it takes a parsed JSON value and returns the migrated
 * value plus a per-row report. File IO + diff rendering live in `codemod.ts`.
 */

/** Reserved token used to mark a NOT_APPLICABLE-routed row (MIGRATION.md). */
export const NOT_APPLICABLE_TOKEN = "__not_applicable__";

/** Self-describing reason appended to a NOT_APPLICABLE-routed row. */
export const NOT_APPLICABLE_REASON =
  "routed from NOT_APPLICABLE per DR-018 §279 — non-verdict, not a pass";

const V1_DECISION_MAP: Record<string, "pass" | "fail" | "advisory" | "error"> = {
  PASS: "pass",
  FAIL: "fail",
  ADVISORY: "advisory",
};

/** Outcome classification for a single attempted row migration. */
export type RowOutcome =
  | "migrated" // was v1-shaped; rewritten to v2
  | "already-v2" // already had gate_decision; left unchanged
  | "not-a-statement" // not an object with a predicate; left unchanged
  | "error"; // recognizable v1 row that could not be migrated

export interface RowReport {
  /** Index into the bundle (array form) or 0 for a single-statement input. */
  index: number;
  outcome: RowOutcome;
  /** gate_id when extractable, else null. */
  gateId: string | null;
  /** Human-readable note (error message or routing note). */
  note: string | null;
}

export interface MigrateBundleResult {
  /** The migrated value, structurally mirroring the input container. */
  migrated: unknown;
  /** Per-row outcome reports in input order. */
  rows: RowReport[];
  /** True when at least one row was actually rewritten. */
  changed: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Migrate an in-memory Evidence Bundle value. Accepts all three shapes a
 * consumer fixture might be in:
 *
 *   1. a plain array of statements           → migrate each element
 *   2. a `{ bundle_format, rows: [...] }`     → migrate each row, keep wrapper
 *   3. a single statement object             → migrate the one statement
 *
 * Rows that are already v2 (have `predicate.gate_decision`) or that are not
 * statements are passed through untouched and reported as such.
 */
export function migrateBundle(input: unknown): MigrateBundleResult {
  if (Array.isArray(input)) {
    const rows: RowReport[] = [];
    const migrated = input.map((row, index) => {
      const r = migrateStatement(row, index);
      rows.push(r.report);
      return r.value;
    });
    return { migrated, rows, changed: rows.some((r) => r.outcome === "migrated") };
  }

  if (isObject(input) && Array.isArray(input.rows)) {
    const rows: RowReport[] = [];
    const migratedRows = input.rows.map((row, index) => {
      const r = migrateStatement(row, index);
      rows.push(r.report);
      return r.value;
    });
    const migrated: JsonObject = { ...input, rows: migratedRows };
    return { migrated, rows, changed: rows.some((r) => r.outcome === "migrated") };
  }

  const single = migrateStatement(input, 0);
  return {
    migrated: single.value,
    rows: [single.report],
    changed: single.report.outcome === "migrated",
  };
}

interface MigrateStatementResult {
  value: unknown;
  report: RowReport;
}

/** Migrate a single statement object. Non-statements pass through. */
export function migrateStatement(input: unknown, index: number): MigrateStatementResult {
  if (!isObject(input) || !isObject(input.predicate)) {
    return {
      value: input,
      report: { index, outcome: "not-a-statement", gateId: null, note: null },
    };
  }

  const predicate = input.predicate;
  const gateId = typeof predicate.gate_id === "string" ? predicate.gate_id : null;

  // Already v2? Leave untouched.
  if ("gate_decision" in predicate) {
    return {
      value: input,
      report: { index, outcome: "already-v2", gateId, note: null },
    };
  }

  // Recognizable v1 row only if it carries the old `result` key.
  if (!("result" in predicate)) {
    return {
      value: input,
      report: {
        index,
        outcome: "error",
        gateId,
        note: "predicate has neither gate_decision (v2) nor result (v1) — cannot migrate",
      },
    };
  }

  const migrated = migratePredicate(predicate);
  if (migrated.error !== null) {
    return {
      value: input,
      report: { index, outcome: "error", gateId, note: migrated.error },
    };
  }

  return {
    value: { ...input, predicate: migrated.predicate },
    report: { index, outcome: "migrated", gateId, note: migrated.note },
  };
}

interface MigratePredicateResult {
  predicate: JsonObject;
  error: string | null;
  note: string | null;
}

function migratePredicate(v1: JsonObject): MigratePredicateResult {
  const rawResult = v1.result;
  if (typeof rawResult !== "string") {
    return {
      predicate: v1,
      error: `v1 'result' must be a string (got ${typeof rawResult})`,
      note: null,
    };
  }

  const gateReasons = Array.isArray(v1.gate_reasons)
    ? (v1.gate_reasons as unknown[]).filter((r): r is string => typeof r === "string")
    : [];
  const dimsEvaluated: string[] = [];
  const dimsSkipped: string[] = [];
  let note: string | null = null;
  let gateDecision: "pass" | "fail" | "advisory" | "error";

  if (rawResult === "NOT_APPLICABLE") {
    // DR-018 §279 routing: non-verdict pass + skipped dimension token + reason.
    gateDecision = "pass";
    dimsSkipped.push(NOT_APPLICABLE_TOKEN);
    gateReasons.push(NOT_APPLICABLE_REASON);
    note = "routed NOT_APPLICABLE via coverage.dimensions_skipped";
  } else {
    const mapped = V1_DECISION_MAP[rawResult];
    if (mapped === undefined) {
      return {
        predicate: v1,
        error: `unknown v1 result value '${rawResult}' (expected PASS|FAIL|ADVISORY|NOT_APPLICABLE)`,
        note: null,
      };
    }
    gateDecision = mapped;
  }

  const gateId = typeof v1.gate_id === "string" ? v1.gate_id : "";
  const runner = typeof v1.runner === "string" ? v1.runner : "";

  // Build the v2 predicate. Field ORDER mirrors the writer (writer.ts) so a
  // migrated row diffs cleanly against a freshly-emitted one.
  const v2: JsonObject = {
    gate_id: gateId,
    gate_name: deriveGateName(gateId),
    gate_version: deriveGateVersion(runner),
    gate_decision: gateDecision,
    gate_reasons: gateReasons,
    coverage: {
      dimensions_evaluated: dimsEvaluated,
      dimensions_skipped: dimsSkipped,
    },
    policy_ref: derivePolicyRef(v1.policy_hash),
    policy_hash: v1.policy_hash,
    input_hash: v1.input_hash,
    // RENAME: timestamp → evaluated_at (value unchanged).
    evaluated_at: v1.timestamp,
    runner: v1.runner,
    commit_sha: v1.commit_sha,
  };

  // Preserve passthrough optionals.
  if ("metadata" in v1) v2.metadata = v1.metadata;
  if ("failure_mode" in v1) v2.failure_mode = v1.failure_mode;
  if ("advisory_severity" in v1) v2.advisory_severity = v1.advisory_severity;

  return { predicate: v2, error: null, note };
}

/**
 * Derive a lowercase kebab-case gate_name from the gate_id's 3rd segment
 * (`tool:side:GATE`). Non-conforming ids fall back to `"migrated-gate"`.
 */
export function deriveGateName(gateId: string): string {
  const parts = gateId.split(":");
  const last = parts.length >= 3 ? parts[parts.length - 1] : "";
  const kebab = last
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab.length > 0 ? kebab : "migrated-gate";
}

/**
 * Derive a SemVer gate_version from a `tool@x.y.z` runner string. Falls back
 * to `"0.0.0"` when the runner is missing or unparseable.
 */
export function deriveGateVersion(runner: string): string {
  const m = runner.match(/@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?)$/);
  return m ? m[1] : "0.0.0";
}

/**
 * Derive a policy_ref (`sha256:<hex>:<path>`) from the v1 policy_hash. The
 * path is unknown post-hoc so `unknown` is used as the path segment.
 */
export function derivePolicyRef(policyHash: unknown): string {
  if (typeof policyHash === "string" && policyHash.startsWith("sha256:")) {
    return `${policyHash}:unknown`;
  }
  return `sha256:${"0".repeat(64)}:unknown`;
}
