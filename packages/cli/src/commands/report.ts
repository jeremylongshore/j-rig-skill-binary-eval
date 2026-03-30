import type { Command } from "commander";
import chalk from "chalk";
import { getRun, getRecentRuns, getRunResults, getRunArtifacts } from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { icon, formatDuration, formatScore, header } from "../lib/output.js";

/**
 * Register the `report` command on the given Commander program.
 *
 * Queries and displays evaluation results from the SQLite evidence store.
 * Without `--run-id`, lists recent runs in a compact table.
 * With `--run-id`, prints full criterion results and artifact metadata.
 */
export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Show evaluation results from the database")
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--skill <name>", "Filter by skill name")
    .option("--run-id <id>", "Show detailed results for a specific run", parseInt)
    .option("--limit <n>", "Max runs to show", parseInt, 10)
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        db: string;
        skill?: string;
        runId?: number;
        limit: number;
        json?: boolean;
      }) => {
        try {
          const database = openDb(opts.db);

          if (opts.runId) {
            // Detail mode — single run with criterion results and artifacts
            const run = getRun(database, opts.runId);
            if (!run) {
              console.error(`Run #${opts.runId} not found`);
              process.exit(1);
            }
            const results = getRunResults(database, opts.runId);
            const arts = getRunArtifacts(database, opts.runId);

            if (opts.json) {
              console.log(JSON.stringify({ run, results, artifacts: arts }, null, 2));
            } else {
              const summary = run.summary;
              console.log(header(`Run #${run.id}`));
              console.log(
                `  Status: ${run.status} | Model: ${run.model ?? "n/a"} | Type: ${run.run_type}`,
              );
              if (run.duration_ms != null) {
                console.log(`  Duration: ${formatDuration(run.duration_ms)}`);
              }
              if (summary) {
                console.log(`  Score: ${formatScore(summary.passed, summary.total)}`);
              }

              console.log(`\n  ${header("Criterion Results:")}`);
              for (const r of results) {
                // severity from the DB row is a plain string; cast to the
                // narrowest union accepted by icon().
                const sev = r.severity as "pass" | "error" | "warning" | "info";
                const ic = r.passed ? icon("pass") : icon("error");
                const sevIcon = sev === "warning" ? ` ${icon("warning")}` : "";
                console.log(`    ${ic}${sevIcon} ${r.criterion_id}: ${r.message}`);
              }

              if (arts.length > 0) {
                console.log(`\n  ${header("Artifacts:")}`);
                for (const a of arts) {
                  console.log(`    ${a.filename} (${a.artifact_type})`);
                }
              }
            }
          } else {
            // List mode — compact table of recent runs
            const rows = getRecentRuns(database, {
              limit: opts.limit,
              skillName: opts.skill,
            });

            if (opts.json) {
              console.log(JSON.stringify(rows, null, 2));
            } else {
              console.log(header("Recent Runs:"));
              console.log(
                chalk.dim("  ID   Skill                       Model    Status      Date"),
              );
              for (const row of rows) {
                const r = row.runs;
                const sv = row.skill_versions;
                console.log(
                  `  ${String(r.id).padEnd(5)} ` +
                    `${sv.skill_name.padEnd(28)} ` +
                    `${(r.model ?? "n/a").padEnd(9)} ` +
                    `${r.status.padEnd(12)} ` +
                    `${r.created_at?.slice(0, 10) ?? ""}`,
                );
              }
              if (rows.length === 0) {
                console.log(chalk.dim("  No runs found."));
              }
            }
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      },
    );
}
