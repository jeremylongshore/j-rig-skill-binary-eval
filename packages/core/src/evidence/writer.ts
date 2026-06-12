/**
 * Evidence Bundle writer — v2.0.0 kernel migration (DR-018, iaj-E02).
 *
 * Breaking changes from v1.x:
 *   - `ComposeStatementInput.result` → `gateDecision` (values: pass|fail|advisory|error)
 *   - `ComposeStatementInput.timestamp` → `evaluatedAt`
 *   - NEW required fields: gateName, gateVersion, gateReasons, coverage, policyRef
 *   - NOT_APPLICABLE is no longer a decision value. A dimension that cannot be
 *     evaluated must be listed in `coverage.dimensionsSkipped` with the
 *     gateDecision omitted from the call — the CALLER routes the skip, not
 *     this function. See NOT_APPLICABLE routing note below.
 *
 * NOT_APPLICABLE routing (DR-018 §279):
 *   A gate that determines a particular dimension is not applicable SHOULD NOT
 *   call `composeStatement` for that dimension at all, OR should call it with
 *   the dimension name placed in `coverage.dimensionsSkipped` and the actual
 *   decision (pass/fail) for the dimensions that WERE evaluated. The concept
 *   "not applicable" is expressed at the coverage level, never as a gate
 *   decision value. The CLI `--result NOT_APPLICABLE` flag routes to this:
 *   the dimension is added to `coverage.dimensionsSkipped` and a `pass`
 *   decision with empty `gate_reasons` is emitted (composable + silent on that
 *   dimension, not a verdict). This preserves composability.
 *
 * The writer enforces:
 *   - R2 row-independence: each row is validated against the schema before
 *     emission; a write that would emit an invalid row throws.
 *   - Subject-naming + digest invariants: rows are constructed via
 *     `composeStatement` which derives subject from the predicate.
 *   - Deterministic field ordering so diffs stay stable across pipeline runs.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  EvidenceStatementSchema,
  PREDICATE_URI,
  STATEMENT_TYPE,
  type EvidenceStatement,
  type AdvisorySeverity,
} from "../schemas/evidence-bundle.js";
import type { GateResult } from "../schemas/evidence-bundle.js";

/** Coverage dimensions input (camelCase for TypeScript ergonomics). */
export interface CoverageInput {
  /** Dimensions that were evaluated in this gate run. */
  dimensionsEvaluated: string[];
  /** Dimensions that were skipped (not applicable) in this gate run. */
  dimensionsSkipped: string[];
}

export interface ComposeStatementInput {
  /** SPEC § R8 — pipeline-hop-qualified gate id: tool:side:gate-id. */
  gateId: string;
  /**
   * Gate decision (v2: lowercase). Pass `"pass"`, `"fail"`, `"advisory"`, or
   * `"error"`. NOT_APPLICABLE is handled separately via coverage.dimensionsSkipped
   * — do not pass it here. See NOT_APPLICABLE routing note in module header.
   */
  gateDecision: GateResult;
  /** Human-readable gate name (lowercase kebab-case, e.g. "coverage-check"). */
  gateName: string;
  /** SemVer of the gate implementation (e.g. "2.0.0"). */
  gateVersion: string;
  /**
   * Reasons for the decision — at least one entry is expected. For a clean
   * `pass` with no unusual conditions, use `["all criteria met"]`.
   */
  gateReasons: string[];
  /** Coverage: which dimensions were evaluated vs skipped. */
  coverage: CoverageInput;
  /**
   * Policy reference in the form `sha256:<64-hex>:<path>`.
   * Example: `"sha256:abc...def:vitest.config.ts"`
   */
  policyRef: string;
  /** sha256:<hex> — SPEC § R7. */
  policyHash: string;
  /** sha256:<hex> — SPEC § R7. Subject digest is derived from this. */
  inputHash: string;
  /** RFC 3339 timestamp with timezone offset; defaults to now() when omitted. */
  evaluatedAt?: string;
  /** tool@semver, e.g. "j-rig@2.0.0". */
  runner: string;
  /** Git commit SHA the gate evaluated against. */
  commitSha: string;
  /** Optional free-form gate-specific metadata (informative only). */
  metadata?: Record<string, unknown>;
  /** Required when gateDecision === "fail" if the originating tool documents one. */
  failureMode?: string;
  /** Required when gateDecision === "advisory" per kernel rule. */
  advisorySeverity?: AdvisorySeverity;
}

/**
 * Compose a fully-validated in-toto Statement v1 from gate output.
 *
 * Subject naming + digest invariants are derived automatically:
 *   - subject[0].name = gateId
 *   - subject[0].digest.sha256 = inputHash without the "sha256:" prefix
 *
 * Throws if validation fails. Callers that want soft-failure should call
 * EvidenceStatementSchema.safeParse on the result of a manual composition.
 */
export function composeStatement(input: ComposeStatementInput): EvidenceStatement {
  if (!input.inputHash.startsWith("sha256:")) {
    throw new Error(`composeStatement: inputHash must be sha256:-prefixed (got: ${input.inputHash})`);
  }
  const digestHex = input.inputHash.slice("sha256:".length);
  // Emit ISO 8601 unmodified — lossless sub-second precision and already
  // accepted by Rfc3339Schema (z.string().datetime({ offset: true }) accepts
  // the `Z` suffix). Stripping milliseconds or converting Z→+00:00 is
  // unnecessary and lossy (panel P1 fix).
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();

  const predicate: Record<string, unknown> = {
    gate_id: input.gateId,
    gate_name: input.gateName,
    gate_version: input.gateVersion,
    gate_decision: input.gateDecision,
    gate_reasons: input.gateReasons,
    coverage: {
      dimensions_evaluated: input.coverage.dimensionsEvaluated,
      dimensions_skipped: input.coverage.dimensionsSkipped,
    },
    policy_ref: input.policyRef,
    policy_hash: input.policyHash,
    input_hash: input.inputHash,
    evaluated_at: evaluatedAt,
    runner: input.runner,
    commit_sha: input.commitSha,
  };
  if (input.metadata !== undefined) predicate.metadata = input.metadata;
  if (input.failureMode !== undefined) predicate.failure_mode = input.failureMode;
  if (input.advisorySeverity !== undefined) predicate.advisory_severity = input.advisorySeverity;

  const candidate = {
    _type: STATEMENT_TYPE,
    subject: [
      {
        name: input.gateId,
        digest: { sha256: digestHex },
      },
    ],
    predicateType: PREDICATE_URI,
    predicate,
  };

  const parsed = EvidenceStatementSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `composeStatement: validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Container form selector for {@link writeBundle}. */
export type BundleFormat = "json" | "jsonl" | "array";

export interface WriteBundleOptions {
  format: BundleFormat;
  /** Path of the output file (json/jsonl) or directory (json, one per row). */
  outputPath: string;
  /**
   * When format=json, writes one *.json file per row using this base. The
   * naming pattern is {basename}-{NNNN}.json. Defaults to "row".
   */
  perRowBasename?: string;
}

/**
 * Write a sequence of statements to disk in the requested container form.
 *
 * Throws on the first row that fails schema validation — callers must
 * validate beforehand if they want best-effort write semantics.
 *
 * NOTE: the v2 "array" format emits a plain JSON array (EvidenceBundlePayload),
 * not the v1 `{ bundle_format: "json-array", rows: [...] }` container. The
 * reader still understands both forms for backward compatibility.
 */
export function writeBundle(rows: EvidenceStatement[], opts: WriteBundleOptions): string[] {
  rows.forEach((row, idx) => {
    const check = EvidenceStatementSchema.safeParse(row);
    if (!check.success) {
      throw new Error(
        `writeBundle: row ${idx} failed validation: ${check.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
  });

  const outAbs = resolve(opts.outputPath);
  if (opts.format === "jsonl") {
    ensureDir(dirname(outAbs));
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
    writeFileSync(outAbs, body);
    return [outAbs];
  }

  if (opts.format === "array") {
    ensureDir(dirname(outAbs));
    // v2: plain JSON array (EvidenceBundlePayload wire format per kernel).
    writeFileSync(outAbs, JSON.stringify(rows, null, 2) + "\n");
    return [outAbs];
  }

  // format === "json": one file per row in a directory.
  ensureDir(outAbs);
  const base = opts.perRowBasename ?? "row";
  const written: string[] = [];
  rows.forEach((row, idx) => {
    const name = `${base}-${String(idx).padStart(4, "0")}.json`;
    const path = resolve(outAbs, name);
    writeFileSync(path, JSON.stringify(row, null, 2) + "\n");
    written.push(path);
  });
  return written;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Convenience: serialize one statement to a string in the requested form.
 * For programmatic emission to stdout (the j-rig emit-evidence CLI pipeline).
 */
export function serializeStatement(stmt: EvidenceStatement): string {
  const check = EvidenceStatementSchema.safeParse(stmt);
  if (!check.success) {
    throw new Error(
      `serializeStatement: validation failed: ${check.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    );
  }
  return JSON.stringify(stmt);
}
