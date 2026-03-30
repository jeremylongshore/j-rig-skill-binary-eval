import chalk from "chalk";
import type { CheckSeverity, PackageReport } from "@j-rig/core";
import type { RolloutDecision } from "@j-rig/core";

/**
 * Returns a colored icon character for the given severity level.
 * Accepts the full `CheckSeverity` union plus `"info"` for informational
 * annotations that do not map to a package-check outcome.
 */
export function icon(severity: CheckSeverity | "info"): string {
  switch (severity) {
    case "pass":
      return chalk.green("✓");
    case "error":
      return chalk.red("✗");
    case "warning":
      return chalk.yellow("!");
    case "info":
      return chalk.blue("·");
  }
}

/**
 * Formats a millisecond duration as a human-readable string.
 * Values under 1 000 ms are rendered as `Xms`; otherwise as `X.Xs`.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Formats a `RolloutDecision` as a bold, color-coded label.
 */
export function formatDecision(decision: RolloutDecision): string {
  switch (decision) {
    case "ship":
      return chalk.green.bold("SHIP");
    case "block":
      return chalk.red.bold("BLOCK");
    case "warn":
      return chalk.yellow.bold("WARN");
    case "obsolete_review":
      return chalk.magenta.bold("OBSOLETE_REVIEW");
  }
}

/**
 * Formats a pass/total fraction with a percentage and color coding.
 * Green when all pass, yellow at ≥50 %, red below.
 */
export function formatScore(passed: number, total: number): string {
  const pct = total > 0 ? ((passed / total) * 100).toFixed(0) : "0";
  const color =
    passed === total
      ? chalk.green
      : passed / total >= 0.5
        ? chalk.yellow
        : chalk.red;
  return color(`${passed}/${total} (${pct}%)`);
}

/** Returns a bold, underlined heading string. */
export function header(text: string): string {
  return chalk.bold.underline(text);
}

/** Returns a dimmed (muted) string. */
export function dim(text: string): string {
  return chalk.dim(text);
}

/**
 * Prints a `PackageReport` to stdout.
 * Passes are silent; warnings and errors are printed with an icon and
 * optional details line. A summary line is appended at the end.
 */
export function printReport(report: PackageReport): void {
  const { summary } = report;
  const name = report.skill_name ?? "unknown";

  console.log(header(`Package Check: ${name}`));
  console.log(
    `  ${summary.passed} passed, ${summary.warnings} warnings, ${summary.errors} errors\n`,
  );

  for (const r of report.results) {
    if (r.severity === "pass") continue;
    console.log(`  ${icon(r.severity)} ${chalk.dim(r.id)}: ${r.message}`);
    if (r.details) console.log(`    ${chalk.dim(r.details)}`);
  }

  if (summary.errors === 0) {
    console.log(chalk.green("\n  All checks passed."));
  } else {
    console.log(chalk.red(`\n  ${summary.errors} error(s) must be fixed.`));
  }
}
