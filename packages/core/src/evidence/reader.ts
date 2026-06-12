/**
 * Evidence Bundle reader — v2.0.0 (DR-018, iaj-E02).
 *
 * Loads + validates Statements from disk in any of the supported forms:
 *   1. One-file-per-row: a directory of *.json files (each is one Statement)
 *   2. JSON Lines: .jsonl file, one Statement per line
 *   3. v2 plain array: .json file containing a JSON array of Statements
 *      (EvidenceBundlePayload wire format per kernel)
 *   4. v1 legacy WRAPPER: .json file with `{ bundle_format: "json-array", rows: [...] }`
 *      — the CONTAINER FORM is understood for backward compat, but every ROW inside
 *      it is still validated against the v2 (gate-result/v1) predicate schema.
 *      A genuine v1-BODIED row (using `result`/`timestamp` instead of
 *      `gate_decision`/`evaluated_at`) WILL be rejected as a row-level error.
 *      To consume v1 bundles, re-emit them with the current gate implementation
 *      using the new required flags (P2 reader comment fix).
 *
 * All forms normalize to the same in-memory shape: EvidenceStatement[].
 * Each row is independently validated. R2 row-independence: a malformed row
 * is reported but does not invalidate sibling rows; the caller decides how to
 * handle a partial-failure bundle.
 */
import { readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import {
  EvidenceStatementSchema,
  type EvidenceStatement,
} from "../schemas/evidence-bundle.js";

export interface ReadBundleResult {
  /** Successfully validated Statements. */
  rows: EvidenceStatement[];
  /** Per-row errors, with array index into the source container. */
  errors: { rowIndex: number; source: string; message: string }[];
}

/**
 * Read + validate an Evidence Bundle from a path. The path may be:
 *   - a directory  → reads every *.json child as one Statement
 *   - a .jsonl file → one Statement per non-empty line
 *   - a .json file → plain JSON array (v2), a single Statement, OR a
 *     v1 `{ bundle_format: "json-array", rows: [...] }` container WRAPPER.
 *     NOTE: the v1 WRAPPER is understood; v1 BODIES are not — every row
 *     is validated against the v2 predicate schema regardless of the container
 *     form. v1-bodied rows are reported as row errors.
 *
 * Returns the union of all valid rows and a per-row error list.
 */
export function readBundle(path: string): ReadBundleResult {
  const result: ReadBundleResult = { rows: [], errors: [] };
  const absPath = resolve(path);
  let st;
  try {
    st = statSync(absPath);
  } catch (err) {
    result.errors.push({
      rowIndex: -1,
      source: absPath,
      message: `file system error: ${(err as Error).message}`,
    });
    return result;
  }

  if (st.isDirectory()) {
    const entries = readdirSync(absPath)
      .filter((f) => extname(f) === ".json")
      .sort();
    entries.forEach((entry, idx) => {
      const filePath = join(absPath, entry);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        validateRow(parsed, idx, filePath, result);
      } catch (err) {
        result.errors.push({
          rowIndex: idx,
          source: filePath,
          message: `parse error: ${(err as Error).message}`,
        });
      }
    });
    return result;
  }

  const raw = readFileSync(absPath, "utf-8");

  if (extname(absPath) === ".jsonl") {
    raw.split(/\r?\n/).forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        validateRow(parsed, idx, `${absPath}#L${idx + 1}`, result);
      } catch (err) {
        result.errors.push({
          rowIndex: idx,
          source: `${absPath}#L${idx + 1}`,
          message: `parse error: ${(err as Error).message}`,
        });
      }
    });
    return result;
  }

  // Single .json file: v2 plain array, v1 container, or a single Statement.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    result.errors.push({
      rowIndex: 0,
      source: absPath,
      message: `parse error: ${(err as Error).message}`,
    });
    return result;
  }

  // v2 plain array form (EvidenceBundlePayload).
  if (Array.isArray(parsed)) {
    parsed.forEach((row, idx) => validateRow(row, idx, `${absPath}#[${idx}]`, result));
    return result;
  }

  // v1 legacy container form { bundle_format: "json-array", rows: [...] }.
  if (parsed && typeof parsed === "object" && "bundle_format" in parsed && "rows" in parsed) {
    const fmt = (parsed as { bundle_format?: unknown }).bundle_format;
    if (fmt !== "json-array") {
      result.errors.push({
        rowIndex: -1,
        source: absPath,
        message: `unknown bundle_format '${String(fmt)}' (expected 'json-array')`,
      });
      return result;
    }
    const rows = (parsed as { rows: unknown[] }).rows ?? [];
    if (!Array.isArray(rows)) {
      result.errors.push({
        rowIndex: -1,
        source: absPath,
        message: "bundle.rows must be an array",
      });
      return result;
    }
    rows.forEach((row, idx) => validateRow(row, idx, `${absPath}#rows[${idx}]`, result));
    return result;
  }

  // Single statement form.
  validateRow(parsed, 0, absPath, result);
  return result;
}

function validateRow(
  raw: unknown,
  rowIndex: number,
  source: string,
  result: ReadBundleResult,
): void {
  const check = EvidenceStatementSchema.safeParse(raw);
  if (check.success) {
    result.rows.push(check.data);
  } else {
    result.errors.push({
      rowIndex,
      source,
      message: check.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    });
  }
}
