/**
 * Severity levels for check results.
 * - error: hard failure, blocks release
 * - warning: heuristic concern, does not block
 * - pass: check passed
 */
export type CheckSeverity = "error" | "warning" | "pass";

/**
 * A single check result from a deterministic preflight check.
 */
export interface CheckResult {
  id: string;
  description: string;
  severity: CheckSeverity;
  message: string;
  details?: string;
}

/**
 * The full report from running all deterministic preflight checks
 * against a skill package.
 */
export interface PackageReport {
  skill_name: string | null;
  timestamp: string;
  results: CheckResult[];
  summary: {
    total: number;
    passed: number;
    warnings: number;
    errors: number;
  };
}

/**
 * Build a summary from a list of check results.
 */
export function summarize(results: CheckResult[]): PackageReport["summary"] {
  return {
    total: results.length,
    passed: results.filter((r) => r.severity === "pass").length,
    warnings: results.filter((r) => r.severity === "warning").length,
    errors: results.filter((r) => r.severity === "error").length,
  };
}

/**
 * Format a package report into a human-readable string.
 */
export function formatReport(report: PackageReport): string {
  const lines: string[] = [];
  const name = report.skill_name ?? "(unknown)";
  lines.push(`Package Report: ${name}`);
  lines.push(`  ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.errors} errors`);
  lines.push("");

  for (const r of report.results) {
    if (r.severity === "pass") continue;
    const icon = r.severity === "error" ? "ERROR" : "WARN";
    lines.push(`  [${icon}] ${r.id}: ${r.message}`);
    if (r.details) {
      lines.push(`         ${r.details}`);
    }
  }

  if (report.summary.errors === 0 && report.summary.warnings === 0) {
    lines.push("  All checks passed.");
  }

  return lines.join("\n");
}
