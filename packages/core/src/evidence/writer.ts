/**
 * Evidence Bundle writer — emit a validated EvidenceStatement (or many of
 * them) in any of the three container forms documented in SPEC.md § R1.
 *
 * The writer enforces:
 *   - R2 row-independence: each row is validated against the schema before
 *     emission; a write that would emit an invalid row throws. Callers
 *     should validate beforehand if they want partial-bundle write tolerance.
 *   - Subject-naming + digest invariants (SPEC § R8-R9): rows are constructed
 *     via `composeStatement` which derives subject from the predicate.
 *   - Deterministic field ordering (no JSON sort, but the constructor lays
 *     fields in the SPEC's documented order so diffs against signed rows
 *     stay stable across pipeline runs).
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  EvidenceStatementSchema,
  PREDICATE_URI,
  STATEMENT_TYPE,
  type EvidenceStatement,
  type GateResult,
  type AdvisorySeverity,
} from "../schemas/evidence-bundle.js";

export interface ComposeStatementInput {
  /** SPEC § R8 — pipeline-hop-qualified gate id. */
  gateId: string;
  result: GateResult;
  /** sha256:<hex> — SPEC § R7. */
  policyHash: string;
  /** sha256:<hex> — SPEC § R7. Subject digest is derived from this. */
  inputHash: string;
  /** RFC 3339 UTC timestamp; defaults to now() when omitted. */
  timestamp?: string;
  /** tool@semver, e.g. "j-rig@0.15.0". */
  runner: string;
  /** Git commit SHA the gate evaluated against. */
  commitSha: string;
  /** Optional free-form gate-specific metadata (informative only). */
  metadata?: Record<string, unknown>;
  /** Required when result === "FAIL" if the originating tool documents one. */
  failureMode?: string;
  /** Required when result === "ADVISORY" per SPEC § R6. */
  advisorySeverity?: AdvisorySeverity;
}

/**
 * Compose a fully-validated in-toto Statement v1 from gate output.
 *
 * Subject naming + digest invariants (SPEC § R8-R9) are derived automatically:
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
  const timestamp = input.timestamp ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const predicate: Record<string, unknown> = {
    gate_id: input.gateId,
    result: input.result,
    policy_hash: input.policyHash,
    input_hash: input.inputHash,
    timestamp,
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
  /** Path of the output file (json/jsonl/array) or directory (json + per-row when format=json). */
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
    const container = { bundle_format: "json-array" as const, rows };
    writeFileSync(outAbs, JSON.stringify(container, null, 2) + "\n");
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
