import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  parseAndValidateYaml,
  planBalancedSamples,
  SamplingCellSchema,
  type BalancedSamplingPlan,
  type SamplingCell,
} from "@j-rig/core";
import { getRawRunSampleObservations } from "@j-rig/db";
import { openDb } from "../lib/db.js";

const SamplingManifestSchema = z.object({
  cells: z.array(SamplingCellSchema).min(1),
});

export interface SamplePlanOptions {
  manifestPath: string;
  targetN: number;
  db: string;
}

export interface SamplePlanResult {
  plan: BalancedSamplingPlan;
  cells: SamplingCell[];
}

function loadManifest(path: string): SamplingCell[] {
  const parsed = parseAndValidateYaml(readFileSync(path, "utf8"), SamplingManifestSchema);
  if (!parsed.success) {
    const details = parsed.errors
      .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
      .join("; ");
    throw new Error(`Invalid sampling manifest at ${path}: ${details}`);
  }
  return parsed.data.cells;
}

/** Plan balanced top-ups; execution remains the separate `j-rig run` command. */
export function runSamplePlan(options: SamplePlanOptions): SamplePlanResult {
  const cells = loadManifest(options.manifestPath);
  const database = openDb(options.db);
  try {
    const plan = planBalancedSamples({
      cells,
      existing_runs: getRawRunSampleObservations(database),
      target_n: options.targetN,
    });
    return { plan, cells };
  } finally {
    database.close();
  }
}

function printPlan(result: SamplePlanResult, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(result.plan, null, 2));
    return;
  }
  console.log(`Sampling plan: target N=${result.plan.target_n}`);
  for (const cell of result.plan.cells) {
    console.log(
      `  ${cell.task_id}@${cell.task_version} / ${cell.config_id}@${cell.config_version} / ${cell.model}: ` +
        `${cell.completed_count} completed, ${cell.harness_failure_count} harness failures, ` +
        `${cell.planned_count} planned`,
    );
  }
  console.log(`Jobs: ${result.plan.jobs.length}`);
  for (const job of result.plan.jobs) {
    console.log(
      `  pass ${job.pass_index}: ${job.task_id}@${job.task_version} / ${job.config_id}@${job.config_version} / ${job.model} / sample ${job.sample_index}`,
    );
  }
}

/** Register `j-rig sample-plan`, the resumable execution-sampling planner. */
export function registerSamplePlanCommand(program: Command): void {
  program
    .command("sample-plan")
    .description("Plan balanced target-N top-ups over generic raw Runs")
    .requiredOption("--manifest <path>", "YAML manifest containing Task/Config/Model cells")
    .requiredOption(
      "--target-n <n>",
      "Successful completed Runs required per cell",
      (value: string) => Number(value),
    )
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--json", "Output the plan as JSON")
    .action((opts: { manifest: string; targetN: number; db: string; json?: boolean }) => {
      try {
        printPlan(
          runSamplePlan({
            manifestPath: opts.manifest,
            targetN: opts.targetN,
            db: opts.db,
          }),
          opts.json,
        );
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
