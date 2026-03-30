import type { Command } from "commander";
import chalk from "chalk";
import { clusterFailures, selectWeakest } from "@j-rig/core";
import type { FailureCluster } from "@j-rig/core";
import type { JudgmentResult } from "@j-rig/core";
import type { Criterion } from "@j-rig/core";
import { getRecentRuns, getRunResults } from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { header } from "../lib/output.js";

/**
 * Convert a DB criterion result row into the `JudgmentResult` shape required
 * by the core optimizer.  The DB stores `passed: boolean`; the core layer uses
 * `verdict: "yes" | "no" | "unsure"`.
 */
function toJudgmentResult(row: {
  criterion_id: string;
  passed: boolean;
  severity: string;
  message: string;
  method: string | null;
}): JudgmentResult {
  return {
    criterion_id: row.criterion_id,
    verdict: row.passed ? "yes" : "no",
    confidence: 1,
    reasoning: row.message,
    method: row.method === "judge" ? "judge" : "deterministic",
  };
}

/**
 * Build a minimal `Criterion` record from what the DB row carries.
 * The optimizer needs the criteria map to resolve blocker and method fields;
 * since there is no dedicated getCriteria query helper we reconstruct them
 * from the result rows we already hold.
 */
function toCriterion(row: {
  criterion_id: string;
  method: string | null;
}): Criterion {
  return {
    id: row.criterion_id,
    description: row.criterion_id,
    method: row.method === "judge" ? "judge" : "deterministic",
    blocker: false,
    regression_critical: false,
    baseline_sensitive: false,
    pack_sensitive: false,
  };
}

/**
 * Register the `optimize` command on the given Commander program.
 *
 * Loads the most recent (or specified) run's criterion results, converts them
 * to the core `JudgmentResult` format, then calls `clusterFailures` and
 * `selectWeakest` to surface the highest-priority improvement targets.
 */
export function registerOptimizeCommand(program: Command): void {
  program
    .command("optimize")
    .description("Analyze failures and suggest improvements for a skill")
    .requiredOption("--skill <name>", "Skill name to optimize")
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--run-id <id>", "Optimize from a specific run", parseInt)
    .option("--json", "Output as JSON")
    .action(
      async (opts: { skill: string; db: string; runId?: number; json?: boolean }) => {
        try {
          const database = openDb(opts.db);

          // Resolve the target run ID
          let runId = opts.runId;
          if (runId == null) {
            const runs = getRecentRuns(database, { skillName: opts.skill, limit: 1 });
            if (runs.length === 0) {
              console.error(`No runs found for skill: ${opts.skill}`);
              process.exit(1);
            }
            runId = runs[0].runs.id;
          }

          const dbResults = getRunResults(database, runId);
          if (dbResults.length === 0) {
            console.error(`No results found for run #${runId}`);
            process.exit(1);
          }

          // Convert DB rows → core types
          const judgmentResults: JudgmentResult[] = dbResults.map(toJudgmentResult);
          const criteria: Criterion[] = dbResults.map(toCriterion);

          const clusters: FailureCluster[] = clusterFailures(judgmentResults, criteria);
          const weakest: string | null = selectWeakest(judgmentResults, criteria);

          if (opts.json) {
            console.log(JSON.stringify({ runId, clusters, weakest }, null, 2));
          } else {
            console.log(header(`Optimization Analysis: ${opts.skill} (Run #${runId})`));

            if (clusters.length === 0) {
              console.log(chalk.green("\n  No failures to cluster. All criteria passed."));
            } else {
              console.log("\n  Failure Clusters:");
              for (const c of clusters) {
                const color =
                  c.severity === "critical"
                    ? chalk.red
                    : c.severity === "high"
                      ? chalk.yellow
                      : chalk.dim;
                console.log(
                  `    ${color(`[${c.severity.toUpperCase()}]`)} ${c.pattern} (${c.criterion_ids.length} criteria)`,
                );
                for (const id of c.criterion_ids) {
                  console.log(`      - ${id}`);
                }
              }
            }

            if (weakest != null) {
              console.log(`\n  Weakest Criterion: ${chalk.red.bold(weakest)}`);
              console.log(chalk.dim("  Focus improvement efforts here first."));
            } else {
              console.log(chalk.dim("\n  No single weakest criterion identified."));
            }
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      },
    );
}
