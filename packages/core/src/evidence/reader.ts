/**
 * Evidence Bundle reader — load + validate Statements from disk in any of the
 * three container forms documented in SPEC.md § R1:
 *   1. one-file-per-row (a directory of *.json files)
 *   2. JSON Lines (.jsonl, one Statement per line)
 *   3. JSON array container ({"bundle_format": "json-array", "rows": [...]})
 *
 * All three normalize to the same in-memory shape: EvidenceStatement[].
 *
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
 *   - a .json file → either a single Statement OR an EvidenceBundle container
 *
 * Returns the union of all valid rows and a per-row error list. The caller
 * decides what to do with rows.length === 0 (treat as empty bundle, NOT as
 * "everything failed" — SPEC.md § R2 is explicit about partial validity).
 */
export function readBundle(path: string): ReadBundleResult {
  const result: ReadBundleResult = { rows: [], errors: [] };
  const absPath = resolve(path);
  const st = statSync(absPath);

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

  // Single .json file: either a Statement or a json-array container.
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

  // Detect container form. We only validate row-level shape (not the container
  // wrapper) so a single bad row doesn't double-report (once at container level,
  // once at row level). The container's bundle_format literal is checked
  // implicitly by the presence of the "rows" array.
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
