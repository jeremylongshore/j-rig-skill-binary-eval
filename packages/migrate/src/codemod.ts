/**
 * Codemod driver — walk a directory of Evidence Bundle JSON fixtures, migrate
 * each v0.1.0-draft row to v2.0 shape, and emit a unified diff.
 *
 * Pure-ish: filesystem reads/writes are injected through {@link CodemodFs} so
 * the driver is unit-testable against an in-memory fs without touching disk.
 * The diff renderer is a tiny line-based LCS-free unified diff — adequate for
 * the JSON-pretty-print case where most lines are unchanged.
 */
import { migrateBundle, type RowReport } from "./transform.js";

/** Minimal filesystem surface the codemod needs (injectable for tests). */
export interface CodemodFs {
  /** List files under `dir` recursively, returning absolute-ish paths. */
  walk(dir: string): string[];
  read(path: string): string;
  write(path: string, content: string): void;
}

export interface CodemodOptions {
  /** When false (default), nothing is written — diff-only dry run. */
  write?: boolean;
  /** Only consider files matching this predicate. Default: `*.json`. */
  include?: (path: string) => boolean;
}

export interface FileResult {
  path: string;
  /** Whether this file's content changed under migration. */
  changed: boolean;
  /** Parse error message, or null when the file parsed. */
  parseError: string | null;
  /** Per-row migration reports (empty on parse error). */
  rows: RowReport[];
  /** Unified diff of the change (empty when unchanged or on parse error). */
  diff: string;
  /** Whether the new content was written to disk. */
  written: boolean;
}

export interface CodemodResult {
  files: FileResult[];
  /** Files whose content changed (whether or not written). */
  changedCount: number;
  /** Files that failed to parse. */
  errorCount: number;
}

const DEFAULT_INCLUDE = (p: string): boolean => p.endsWith(".json");

/**
 * Run the codemod over a directory. Returns a per-file result set. Writes are
 * gated on `options.write` (default: dry run — diff only).
 */
export function runCodemod(
  dir: string,
  fs: CodemodFs,
  options: CodemodOptions = {},
): CodemodResult {
  const include = options.include ?? DEFAULT_INCLUDE;
  const doWrite = options.write === true;
  const files: FileResult[] = [];

  for (const path of fs.walk(dir)) {
    if (!include(path)) continue;
    files.push(migrateFile(path, fs, doWrite));
  }

  return {
    files,
    changedCount: files.filter((f) => f.changed).length,
    errorCount: files.filter((f) => f.parseError !== null).length,
  };
}

function migrateFile(path: string, fs: CodemodFs, doWrite: boolean): FileResult {
  const original = fs.read(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch (err) {
    return {
      path,
      changed: false,
      parseError: err instanceof Error ? err.message : String(err),
      rows: [],
      diff: "",
      written: false,
    };
  }

  const result = migrateBundle(parsed);
  if (!result.changed) {
    return { path, changed: false, parseError: null, rows: result.rows, diff: "", written: false };
  }

  // Preserve the original trailing-newline convention.
  const trailingNewline = original.endsWith("\n") ? "\n" : "";
  const next = JSON.stringify(result.migrated, null, 2) + trailingNewline;
  const diff = unifiedDiff(path, original, next);

  let written = false;
  if (doWrite) {
    fs.write(path, next);
    written = true;
  }

  return { path, changed: true, parseError: null, rows: result.rows, diff, written };
}

/**
 * Render a minimal unified diff between two strings. This is NOT a full LCS
 * diff — it emits a single hunk listing every line, marking changed lines with
 * `-`/`+`. For the JSON-pretty-print case the output is readable and stable,
 * which is all the codemod's `--diff` surface needs.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const la = a[i];
    const lb = b[i];
    if (la === lb) {
      if (la !== undefined) lines.push(` ${la}`);
      continue;
    }
    if (la !== undefined) lines.push(`-${la}`);
    if (lb !== undefined) lines.push(`+${lb}`);
  }
  return lines.join("\n");
}
