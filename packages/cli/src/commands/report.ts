import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  parseAndValidateYaml,
  samplingCellKey,
  SamplingCellSchema,
  summarizeGradeObservations,
  type GradeMeasurement,
  type GradeObservation,
  type GradeSelector,
  type SamplingCell,
} from "@j-rig/core";
import {
  getGradeObservations,
  getRun,
  getRecentRuns,
  getRunResults,
  getRunArtifacts,
} from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { icon, formatDuration, formatScore, header } from "../lib/output.js";

const SamplingManifestSchema = z.object({
  cells: z.array(SamplingCellSchema).min(1),
});

export interface SamplingReportOptions {
  manifestPath: string;
  db: string;
  selector: GradeSelector;
}

export interface SamplingReportResult {
  selector: GradeSelector;
  observations: GradeObservation[];
  measurements: GradeMeasurement[];
}

function loadSamplingCells(path: string): SamplingCell[] {
  const parsed = parseAndValidateYaml(readFileSync(path, "utf8"), SamplingManifestSchema);
  if (!parsed.success) {
    const details = parsed.errors
      .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
      .join("; ");
    throw new Error(`Invalid sampling manifest at ${path}: ${details}`);
  }
  return parsed.data.cells;
}

/** Build a report over one exact Grader snapshot and only the manifest cells. */
export function runSamplingReport(options: SamplingReportOptions): SamplingReportResult {
  const cells = loadSamplingCells(options.manifestPath);
  const cellKeys = new Set(cells.map(samplingCellKey));
  const database = openDb(options.db);
  try {
    const observations = getGradeObservations(database, options.selector).filter((observation) =>
      cellKeys.has(samplingCellKey(observation)),
    );
    return {
      selector: options.selector,
      observations,
      measurements: summarizeGradeObservations(observations, options.selector),
    };
  } finally {
    database.close();
  }
}

function printSamplingReport(result: SamplingReportResult, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(header("Sampling Measurements:"));
  console.log(
    `  Grader: ${result.selector.grader_id}@${result.selector.grader_version} ` +
      `(${result.selector.grader_snapshot_sha256})`,
  );
  for (const measurement of result.measurements) {
    const interval = measurement.confidence_interval_95
      ? `${measurement.confidence_interval_95.lower.toFixed(3)}–${measurement.confidence_interval_95.upper.toFixed(3)}`
      : "n/a";
    const rate = measurement.pass_rate === null ? "n/a" : measurement.pass_rate.toFixed(3);
    const judge =
      measurement.judge_sampled_runs === 0
        ? "judge n/a"
        : `judge ${measurement.judge_vote_count} votes / ${measurement.judge_disagreement_count} disagree`;
    console.log(
      `  ${measurement.task_id}@${measurement.task_version} / ` +
        `${measurement.config_id}@${measurement.config_version} / ${measurement.model}: ` +
        `${measurement.completed_runs}/${measurement.attempted_runs} complete, ` +
        `${measurement.graded_runs} graded, pass ${rate}, 95% CI ${interval}, ${judge}`,
    );
  }
}

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
    .option("--sampling-manifest <path>", "Report generic sampling cells from a YAML manifest")
    .option("--grader-id <id>", "Selected Grader id for a sampling report")
    .option("--grader-version <version>", "Selected Grader version for a sampling report")
    .option(
      "--grader-snapshot-sha256 <digest>",
      "Selected Grader snapshot digest for a sampling report",
    )
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        db: string;
        skill?: string;
        runId?: number;
        limit: number;
        samplingManifest?: string;
        graderId?: string;
        graderVersion?: string;
        graderSnapshotSha256?: string;
        json?: boolean;
      }) => {
        let database: ReturnType<typeof openDb> | undefined;
        try {
          if (opts.samplingManifest) {
            if (!opts.graderId || !opts.graderVersion || !opts.graderSnapshotSha256) {
              throw new Error(
                "sampling reports require --grader-id, --grader-version, and --grader-snapshot-sha256",
              );
            }
            printSamplingReport(
              runSamplingReport({
                manifestPath: opts.samplingManifest,
                db: opts.db,
                selector: {
                  grader_id: opts.graderId,
                  grader_version: opts.graderVersion,
                  grader_snapshot_sha256: opts.graderSnapshotSha256,
                },
              }),
              opts.json,
            );
            return;
          }

          database = openDb(opts.db);

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
        } finally {
          database?.close();
        }
      },
    );
}
