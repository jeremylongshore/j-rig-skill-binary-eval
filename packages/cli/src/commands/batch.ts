import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  parseAndValidateYaml,
  planBalancedSamples,
  samplingCellKey,
  SamplingCellSchema,
  type BalancedSamplingPlan,
  type SamplingCell,
} from "@j-rig/core";
import { getRawRunSampleObservations } from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { loadGenericDefinitions, runGenericEval, type GenericRunResult } from "./run.js";

const BatchEntrySchema = z.object({
  task: z.string().min(1),
  config: z.string().min(1),
});

const BatchManifestSchema = z.object({
  target_n: z.number().int().positive().optional(),
  jobs: z.array(BatchEntrySchema).min(1),
});

type BatchEntry = z.infer<typeof BatchEntrySchema>;

export interface BatchCommandOptions {
  manifestPath: string;
  db: string;
  targetN?: number;
}

export interface BatchRunResult {
  target_n: number;
  initial_plan: BalancedSamplingPlan;
  runs: GenericRunResult[];
  remaining_plan: BalancedSamplingPlan;
}

interface ResolvedBatchEntry {
  taskPath: string;
  configPath: string;
  cell: SamplingCell;
}

function loadManifest(path: string): { targetN?: number; jobs: BatchEntry[] } {
  const parsed = parseAndValidateYaml(readFileSync(path, "utf8"), BatchManifestSchema);
  if (!parsed.success) {
    const details = parsed.errors
      .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
      .join("; ");
    throw new Error(`Invalid batch manifest at ${path}: ${details}`);
  }
  return { targetN: parsed.data.target_n, jobs: parsed.data.jobs };
}

function resolveEntries(manifestPath: string, jobs: BatchEntry[]): ResolvedBatchEntry[] {
  const baseDir = dirname(resolve(manifestPath));
  const resolved = jobs.map((job) => {
    const taskPath = resolve(baseDir, job.task);
    const configPath = resolve(baseDir, job.config);
    const { task, config } = loadGenericDefinitions(taskPath, configPath);
    const cell = {
      task_id: task.id,
      task_version: task.version,
      config_id: config.id,
      config_version: config.version,
      model: config.model,
    };
    const parsed = SamplingCellSchema.safeParse(cell);
    if (!parsed.success) {
      throw new Error(`Batch entry ${job.task} / ${job.config} has an invalid sampling cell`);
    }
    return { taskPath, configPath, cell: parsed.data };
  });

  const seen = new Set<string>();
  for (const entry of resolved) {
    const key = samplingCellKey(entry.cell);
    if (seen.has(key)) throw new Error(`Duplicate batch sampling cell: ${key}`);
    seen.add(key);
  }
  return resolved;
}

function readPlan(dbPath: string, cells: SamplingCell[], targetN: number): BalancedSamplingPlan {
  const database = openDb(dbPath);
  try {
    return planBalancedSamples({
      cells,
      existing_runs: getRawRunSampleObservations(database),
      target_n: targetN,
    });
  } finally {
    database.close();
  }
}

/** Execute a path-based suite in balanced passes and resume from raw Runs. */
export async function runBatch(options: BatchCommandOptions): Promise<BatchRunResult> {
  const manifestPath = resolve(options.manifestPath);
  const manifest = loadManifest(manifestPath);
  const targetN = options.targetN ?? manifest.targetN;
  if (targetN === undefined) {
    throw new Error(`Batch manifest ${manifestPath} must define target_n or pass --target-n`);
  }

  const entries = resolveEntries(manifestPath, manifest.jobs);
  const cells = entries.map((entry) => entry.cell);
  const initialPlan = readPlan(options.db, cells, targetN);
  const byCell = new Map(entries.map((entry) => [samplingCellKey(entry.cell), entry]));
  const runs: GenericRunResult[] = [];

  for (const job of initialPlan.jobs) {
    const entry = byCell.get(samplingCellKey(job));
    if (!entry) throw new Error(`No batch entry found for ${samplingCellKey(job)}`);
    runs.push(
      await runGenericEval({
        taskPath: entry.taskPath,
        configPath: entry.configPath,
        db: options.db,
        sampleIndex: job.sample_index,
      }),
    );
  }

  return {
    target_n: targetN,
    initial_plan: initialPlan,
    runs,
    remaining_plan: readPlan(options.db, cells, targetN),
  };
}

function printBatch(result: BatchRunResult, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Batch target N=${result.target_n}`);
  for (const run of result.runs) {
    console.log(
      `  ${run.run.task_id}@${run.run.task_version} / ${run.run.config_id}@${run.run.config_version} ` +
        `/ ${run.run.model} / sample ${run.run.sample_index}: ${run.run.status}` +
        `${run.reused ? " (reused)" : ""}`,
    );
  }
  console.log(`Executed: ${result.runs.length}`);
  console.log(`Remaining jobs: ${result.remaining_plan.jobs.length}`);
}

/** Register `j-rig batch`, the resumable balanced suite execution surface. */
export function registerBatchCommand(program: Command): void {
  program
    .command("batch")
    .description("Execute a resumable balanced task/config batch")
    .requiredOption("--manifest <path>", "Path-based batch manifest YAML")
    .option(
      "--target-n <n>",
      "Successful completed Runs required per batch cell",
      (value: string) => Number(value),
    )
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--json", "Output plans and Run results as JSON")
    .action(async (opts: { manifest: string; targetN?: number; db: string; json?: boolean }) => {
      try {
        const result = await runBatch({
          manifestPath: opts.manifest,
          targetN: opts.targetN,
          db: opts.db,
        });
        printBatch(result, opts.json);
        if (result.runs.some((run) => run.run.status !== "completed")) {
          process.exitCode = 1;
        }
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
