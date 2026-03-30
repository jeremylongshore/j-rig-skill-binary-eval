import type { Command } from "commander";
import { checkPackage } from "@j-rig/core";
import { printReport } from "../lib/output.js";

/**
 * Register the `check` command on the given Commander program.
 *
 * Runs all deterministic package integrity checks against a skill directory.
 * No LLM is invoked — this is a pure structural and metadata validation pass.
 *
 * Exit codes:
 *   0 — all checks passed (errors count is zero)
 *   1 — one or more errors, or an unexpected runtime failure
 */
export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Run package integrity checks on a skill directory")
    .argument("<skill-dir>", "Path to skill directory containing SKILL.md")
    .option("--json", "Output as JSON")
    .action(async (skillDir: string, opts: { json?: boolean }) => {
      try {
        const report = checkPackage(skillDir);

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          printReport(report);
        }

        process.exit(report.summary.errors > 0 ? 1 : 0);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
