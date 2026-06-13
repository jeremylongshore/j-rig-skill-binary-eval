#!/usr/bin/env -S node --experimental-strip-types
/**
 * license-audit.ts — dependency-license audit for the j-rig monorepo
 * (bead iaj-E05e, "license audit per GC binding").
 *
 * GC binding (DR-010 §12 / iaj-E05 acceptance criteria): every dependency that
 * ships in a published j-rig artifact MUST carry a license that is compatible
 * with the repo's own Apache-2.0 license. This script is the deterministic,
 * CI-runnable gate that proves it — and fails closed on anything it cannot
 * positively classify as compatible.
 *
 * How it works (zero extra dependencies — uses pnpm's own resolver):
 *   1. Shell out to `pnpm licenses list --json` to enumerate every package in
 *      the workspace dependency graph and its declared SPDX license.
 *   2. Classify each declared license against an Apache-2.0-compatible
 *      allowlist. SPDX OR-expressions ("(MIT OR WTFPL)") pass if ANY disjunct
 *      is on the allowlist (the consumer may elect the permissive option).
 *      AND-expressions and unrecognized strings are NOT auto-passed.
 *   3. Print a per-license summary. Exit 1 if any package's license is not
 *      positively classified as allowed; exit 0 otherwise.
 *
 * Scope:
 *   --prod        audit runtime (production) dependencies only [default policy
 *                 for the publish gate — dev tooling does not ship].
 *   (no flag)     audit the full graph (prod + dev), used for the broader
 *                 hygiene report.
 *
 * Per-package exceptions (rare, GC-reviewed) live in ALLOWLISTED_PACKAGES below
 * with a documented rationale. Keep that list empty unless a specific package
 * carries a non-SPDX or dual-license string the classifier cannot parse.
 *
 * This file is policy + classifier ONLY. The allowlist is the GC-reviewed
 * source of truth; widen it only with a recorded rationale.
 */

import { execFileSync } from "node:child_process";

/**
 * SPDX identifiers that are compatible with redistributing under Apache-2.0.
 * These are the standard permissive licenses (MIT/BSD/ISC family), Apache-2.0
 * itself, and a few public-domain-equivalent dedications. Copyleft licenses
 * (GPL/LGPL/AGPL/MPL/EPL/CDDL) are deliberately ABSENT — adding one is a
 * GC decision, not an engineering one.
 */
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "Apache-2.0",
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "WTFPL",
  "BlueOak-1.0.0",
  "Python-2.0",
  "MIT-0",
  "CC-BY-4.0",
]);

/**
 * Per-package exceptions. Each entry MUST carry a GC-reviewed rationale. Keep
 * this empty unless a package declares a license string the SPDX classifier
 * cannot resolve (e.g. a custom dual-license phrase) yet is confirmed
 * Apache-2.0-compatible by manual review.
 */
export const ALLOWLISTED_PACKAGES: ReadonlyMap<string, string> = new Map([
  // "some-pkg": "GC-reviewed YYYY-MM-DD — declares 'Custom OR MIT'; MIT elected.",
]);

export interface PackageRecord {
  name: string;
  versions: string[];
  license: string;
}

/**
 * Parse the JSON emitted by `pnpm licenses list --json` into a flat list of
 * package records. The pnpm shape is `{ "<license>": [ { name, versions,
 * license, ... }, ... ], ... }`. We trust the per-package `license` field
 * rather than the top-level key (they agree, but the per-package field is the
 * authoritative SPDX string).
 */
export function parsePnpmLicenses(raw: string): PackageRecord[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("license-audit: unexpected pnpm licenses JSON (not an object)");
  }
  const out: PackageRecord[] = [];
  for (const group of Object.values(parsed as Record<string, unknown>)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const name = typeof e.name === "string" ? e.name : "<unknown>";
      const license = typeof e.license === "string" ? e.license : "UNKNOWN";
      const versions = Array.isArray(e.versions)
        ? e.versions.filter((v): v is string => typeof v === "string")
        : [];
      out.push({ name, versions, license });
    }
  }
  return out;
}

/**
 * Decide whether a declared SPDX license string is compatible.
 *
 * Handles three shapes:
 *   - A bare identifier ("MIT") → allowed iff on the allowlist.
 *   - An OR-expression ("(BSD-2-Clause OR MIT OR Apache-2.0)") → allowed iff
 *     ANY disjunct is on the allowlist (consumer elects the permissive term).
 *   - Anything else (AND-expressions, "SEE LICENSE IN ...", "UNKNOWN", "") →
 *     NOT allowed (fail closed; requires explicit per-package review).
 */
export function isLicenseAllowed(license: string): boolean {
  const normalized = license.trim();
  if (normalized === "") return false;

  // Strip surrounding parens, e.g. "(MIT OR WTFPL)".
  const inner = normalized.replace(/^\(/, "").replace(/\)$/, "").trim();

  // OR-expression: any permissive disjunct suffices.
  if (/\bOR\b/i.test(inner) && !/\bAND\b/i.test(inner)) {
    return inner
      .split(/\bOR\b/i)
      .map((part) => part.trim())
      .some((part) => ALLOWED_LICENSES.has(part));
  }

  // AND-expressions are not auto-passed (every term must be compatible AND the
  // combined obligations reviewed) — treat as needing manual review.
  if (/\bAND\b/i.test(inner)) return false;

  return ALLOWED_LICENSES.has(inner);
}

export interface AuditResult {
  total: number;
  allowed: PackageRecord[];
  violations: PackageRecord[];
  byLicense: Map<string, number>;
}

/** Classify a list of package records into allowed vs. violations. */
export function auditPackages(packages: PackageRecord[]): AuditResult {
  const allowed: PackageRecord[] = [];
  const violations: PackageRecord[] = [];
  const byLicense = new Map<string, number>();

  for (const pkg of packages) {
    byLicense.set(pkg.license, (byLicense.get(pkg.license) ?? 0) + 1);
    if (isLicenseAllowed(pkg.license) || ALLOWLISTED_PACKAGES.has(pkg.name)) {
      allowed.push(pkg);
    } else {
      violations.push(pkg);
    }
  }

  return { total: packages.length, allowed, violations, byLicense };
}

/** Run `pnpm licenses list --json [--prod]` and return its stdout. */
function readLicensesFromPnpm(prodOnly: boolean): string {
  const args = ["licenses", "list", "--json"];
  if (prodOnly) args.push("--prod");
  return execFileSync("pnpm", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function main(argv: string[]): number {
  const prodOnly = argv.includes("--prod");
  const scopeLabel = prodOnly ? "runtime (--prod)" : "full graph (prod + dev)";

  let raw: string;
  try {
    raw = readLicensesFromPnpm(prodOnly);
  } catch (err) {
    console.error(`license-audit: failed to run 'pnpm licenses list --json': ${String(err)}`);
    return 1;
  }

  const packages = parsePnpmLicenses(raw);
  const result = auditPackages(packages);

  console.log(`license-audit — scope: ${scopeLabel}`);
  console.log(`  ${result.total} package(s) audited\n`);
  console.log("  By declared license:");
  for (const [license, count] of [...result.byLicense.entries()].sort()) {
    const mark = isLicenseAllowed(license) ? "ok " : "!! ";
    console.log(`    ${mark}${license}: ${count}`);
  }

  if (result.violations.length === 0) {
    console.log(`\n  PASS — every dependency is Apache-2.0-compatible.`);
    return 0;
  }

  console.error(
    `\n  FAIL — ${result.violations.length} package(s) with a non-allowlisted license:`,
  );
  for (const v of result.violations) {
    console.error(`    - ${v.name}@${v.versions.join(",")} → ${v.license}`);
  }
  console.error(
    `\n  Resolve by: (a) removing/replacing the dependency, or (b) adding a` +
      ` GC-reviewed entry to ALLOWLISTED_PACKAGES in scripts/license-audit.ts.`,
  );
  return 1;
}

// Only run main() when invoked directly, not when imported by the test file.
// `import.meta.url` ends with this filename when executed as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
