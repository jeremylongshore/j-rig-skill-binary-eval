import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { z } from "zod";
import {
  ExecutableRunner,
  EvalConfigSchema,
  EvalTaskSchema,
  parseAndValidateYaml,
  type EvalConfig,
  type EvalTask,
  type RunnerRequest,
} from "@j-rig/core";
import {
  createRawRun,
  deriveRawRunId,
  getRawRunArtifacts,
  isRawRunSealed,
  sealRawRun,
  startRawRun,
} from "@j-rig/db";
import { openDb } from "../lib/db.js";

export interface GenericRunOptions {
  taskPath: string;
  configPath: string;
  db: string;
  sampleIndex: number;
}

export interface GenericRunResult {
  run: NonNullable<ReturnType<typeof createRawRun>>;
  artifacts: ReturnType<typeof getRawRunArtifacts>;
  reused: boolean;
}

function loadYaml<T>(path: string, schema: z.ZodType<T>): T {
  const content = readFileSync(path, "utf8");
  const parsed = parseAndValidateYaml(content, schema);
  if (!parsed.success) {
    const details = parsed.errors
      .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
      .join("; ");
    throw new Error(`Invalid evaluation definition at ${path}: ${details}`);
  }
  return parsed.data;
}

function loadTask(path: string): EvalTask {
  return loadYaml(resolve(path), EvalTaskSchema);
}

function loadConfig(path: string): EvalConfig {
  const absolutePath = resolve(path);
  const parsed = loadYaml(absolutePath, EvalConfigSchema);
  return {
    ...parsed,
    harness: {
      ...parsed.harness,
      // Relative harness paths are anchored to the config file, not whichever
      // directory happened to launch the CLI.
      cwd: resolve(dirname(absolutePath), parsed.harness.cwd ?? "."),
    },
  };
}

function lineageFrom(request: RunnerRequest) {
  return {
    task_id: request.task.id,
    task_version: request.task.version,
    config_id: request.config.id,
    config_version: request.config.version,
    model: request.model,
    sample_index: request.sample_index,
  };
}

/** Execute one generic task/config sample and persist its raw observation. */
export async function runGenericEval(options: GenericRunOptions): Promise<GenericRunResult> {
  if (!Number.isInteger(options.sampleIndex) || options.sampleIndex < 0) {
    throw new Error(`sampleIndex must be a non-negative integer (got ${options.sampleIndex})`);
  }

  const task = loadTask(options.taskPath);
  const config = loadConfig(options.configPath);
  const requestWithoutId: Omit<RunnerRequest, "run_id"> = {
    task,
    config,
    model: config.model,
    sample_index: options.sampleIndex,
  };
  const runId = deriveRawRunId(lineageFrom({ ...requestWithoutId, run_id: "" }));
  const request: RunnerRequest = { ...requestWithoutId, run_id: runId };
  const database = openDb(options.db);

  try {
    const created = createRawRun(database, {
      ...lineageFrom(request),
      run_id: runId,
      task,
      config,
      request,
    });

    if (isRawRunSealed(created.status)) {
      return { run: created, artifacts: getRawRunArtifacts(database, runId), reused: true };
    }

    startRawRun(database, runId);
    const observation = await new ExecutableRunner().run(request);
    const sealed = sealRawRun(database, runId, observation);
    return { run: sealed, artifacts: getRawRunArtifacts(database, runId), reused: false };
  } finally {
    database.close();
  }
}

function printRun(result: GenericRunResult, json: boolean | undefined): void {
  const payload = {
    run: result.run,
    artifacts: result.artifacts,
    reused: result.reused,
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Raw Run ${result.run.id}`);
  console.log(
    `  ${result.run.task_id}@${result.run.task_version} / ${result.run.config_id}@${result.run.config_version}`,
  );
  console.log(`  Model: ${result.run.model} | Sample: ${result.run.sample_index}`);
  console.log(`  Status: ${result.run.status}${result.reused ? " (resumed/read-only)" : ""}`);
  if (result.run.duration_ms !== null) console.log(`  Duration: ${result.run.duration_ms} ms`);
  if (result.run.error_message) console.log(`  Error: ${result.run.error_message}`);
  if (result.artifacts.length > 0) console.log(`  Artifacts: ${result.artifacts.length}`);
}

/** Register `j-rig run`, the generic task/config/harness execution seam. */
export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Execute one task/config sample through a shell-free generic harness")
    .requiredOption("--task <path>", "YAML task definition")
    .requiredOption("--config <path>", "YAML configuration with model and harness")
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--sample-index <n>", "Zero-based sample index", (value: string) => Number(value), 0)
    .option("--json", "Output the raw run as JSON")
    .action(
      async (opts: {
        task: string;
        config: string;
        db: string;
        sampleIndex: number;
        json?: boolean;
      }) => {
        try {
          const result = await runGenericEval({
            taskPath: opts.task,
            configPath: opts.config,
            db: opts.db,
            sampleIndex: opts.sampleIndex,
          });
          printRun(result, opts.json);
          if (result.run.status !== "completed") process.exitCode = 1;
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      },
    );
}
