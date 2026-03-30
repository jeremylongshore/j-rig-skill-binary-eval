import type { Command } from "commander";
import chalk from "chalk";
import { needsReevaluation } from "@j-rig/core";
import { getRecentRuns } from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { header } from "../lib/output.js";

/**
 * Register the `drift` command on the given Commander program.
 *
 * Checks whether a skill's last evaluation run is older than `--max-age` days.
 * Exits 0 in all non-error paths; the stale flag is communicated through
 * output text (or the JSON `stale` field) rather than the exit code.
 */
export function registerDriftCommand(program: Command): void {
  program
    .command("drift")
    .description("Check if a skill needs reevaluation")
    .requiredOption("--skill <name>", "Skill name to check")
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--max-age <days>", "Days before flagging stale", parseInt, 30)
    .option("--json", "Output as JSON")
    .action(
      async (opts: { skill: string; db: string; maxAge: number; json?: boolean }) => {
        try {
          const database = openDb(opts.db);
          const runs = getRecentRuns(database, { skillName: opts.skill, limit: 2 });

          if (runs.length === 0) {
            if (opts.json) {
              console.log(
                JSON.stringify({ skill: opts.skill, status: "no_data", stale: true }),
              );
            } else {
              console.log(header(`Drift Check: ${opts.skill}`));
              console.log(chalk.yellow("\n  No evaluation history found."));
              console.log(chalk.dim("  Run: j-rig eval <skill-dir>"));
            }
            process.exit(0);
            return;
          }

          const latest = runs[0].runs;
          // created_at is NOT NULL in the schema but the drizzle type includes
          // undefined for columns with a default — fall back to now() to be safe.
          const createdAt: string = latest.created_at ?? new Date().toISOString();
          const stale = needsReevaluation(createdAt, opts.maxAge);
          const daysAgo = Math.floor(
            (Date.now() - new Date(createdAt).getTime()) / 86_400_000,
          );

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  skill: opts.skill,
                  lastEval: createdAt,
                  daysAgo,
                  stale,
                  maxAge: opts.maxAge,
                  status: latest.status,
                },
                null,
                2,
              ),
            );
          } else {
            console.log(header(`Drift Check: ${opts.skill}`));
            console.log(`\n  Last Eval: ${createdAt.slice(0, 10)} (${daysAgo} days ago)`);
            console.log(
              `  Status: ${stale ? chalk.red("STALE") : chalk.green("CURRENT")} ` +
                `(threshold: ${opts.maxAge} days)`,
            );
            console.log(`  Last Run: #${latest.id} (${latest.status})`);

            if (stale) {
              console.log(
                chalk.yellow("\n  Recommendation: Re-run evaluation with `j-rig eval`"),
              );
            }
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      },
    );
}
