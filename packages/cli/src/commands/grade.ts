import type { Command } from "commander";
import { readFileSync } from "node:fs";
import {
  evaluateWithGrader,
  scriptedGrader,
  EvalTaskSchema,
  EvalConfigSchema,
  evaluateWithModelJudge,
  GraderDefinitionSchema,
  hashGraderSnapshot,
  parseAndValidateYaml,
  type GraderDefinition,
  type JudgeProvider,
} from "@j-rig/core";
import { createGrade, getGradesForRun, getRawRun, getRawRunArtifacts } from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { selectJudgeOverride } from "./eval.js";

export interface GradeCommandOptions {
  runId: string;
  graderPath?: string;
  scriptedImportPath?: string;
  db: string;
  regrade: boolean;
  provider?: string;
  /** Injectable judge seam for deterministic CLI tests and offline callers. */
  judge?: JudgeProvider;
}

export interface GradeCommandResult {
  grade: NonNullable<ReturnType<typeof createGrade>>["grade"];
  created: boolean;
}

export function loadGraderDefinition(path: string): GraderDefinition {
  const content = readFileSync(path, "utf8");
  const parsed = parseAndValidateYaml(content, GraderDefinitionSchema);
  if (!parsed.success) {
    const details = parsed.errors
      .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
      .join("; ");
    throw new Error(`Invalid grader definition at ${path}: ${details}`);
  }
  return parsed.data;
}

/** Grade one completed raw Run and persist an immutable Grade snapshot. */
export async function runGrade(options: GradeCommandOptions): Promise<GradeCommandResult> {
  if (!!options.graderPath === !!options.scriptedImportPath)
    throw new Error("Supply exactly one of --grader or --scripted-import");
  const legacyDefinition = options.graderPath
    ? loadGraderDefinition(options.graderPath)
    : undefined;
  const database = openDb(options.db);

  try {
    const rawRun = getRawRun(database, options.runId);
    if (!rawRun) throw new Error(`Raw Run ${options.runId} not found`);
    if (rawRun.status !== "completed") {
      throw new Error(
        `Raw Run ${options.runId} is ${rawRun.status}; only completed Runs can be graded`,
      );
    }

    if (options.scriptedImportPath) {
      const saved = JSON.parse(rawRun.request_json) as Record<string, unknown>;
      const task = EvalTaskSchema.parse(saved["task"]);
      const config = EvalConfigSchema.parse(saved["config"]);
      if (
        task.id !== rawRun.task_id ||
        task.version !== rawRun.task_version ||
        config.id !== rawRun.config_id ||
        config.version !== rawRun.config_version ||
        saved["run_id"] !== rawRun.id ||
        saved["sample_index"] !== rawRun.sample_index ||
        saved["model"] !== rawRun.model ||
        JSON.stringify(saved["task"]) !== rawRun.task_json ||
        JSON.stringify(saved["config"]) !== rawRun.config_json
      )
        throw new Error("stored scripted request identity is inconsistent");
    }
    const definition = options.scriptedImportPath
      ? scriptedGrader(
          JSON.parse(readFileSync(options.scriptedImportPath, "utf8")),
          JSON.parse(rawRun.request_json),
        )
      : legacyDefinition!;

    // Resolve saved evidence and version policy before any provider selection
    // or billable judge call. An unchanged snapshot is a read-only operation,
    // including when --regrade is supplied.
    const snapshotHash = hashGraderSnapshot(definition);
    const existingGrades = getGradesForRun(database, rawRun.id);
    const exactGrade = existingGrades.find(
      (grade) =>
        grade.grader_id === definition.id &&
        grade.grader_version === definition.version &&
        grade.grader_snapshot_sha256 === snapshotHash,
    );
    if (exactGrade) return { grade: exactGrade, created: false };
    if (existingGrades.some((grade) => grade.grader_id === definition.id) && !options.regrade) {
      throw new Error(
        `Raw Run ${rawRun.id} already has ${definition.id}; pass --regrade to add ${definition.version} or a changed snapshot`,
      );
    }

    let evaluation: ReturnType<typeof evaluateWithGrader>;
    if (definition.kind === "deterministic") {
      // Structured checks read the sealed exit code and artifact manifest.
      evaluation = evaluateWithGrader(rawRun.id, rawRun.stdout ?? "", definition, {
        exit_code: rawRun.exit_code ?? null,
        artifacts: getRawRunArtifacts(database, rawRun.id),
      });
    } else {
      const selectedJudge = options.judge
        ? { judge: options.judge }
        : selectJudgeOverride(definition.model, {
            judgeProvider: options.provider,
            // The model is part of the immutable grader snapshot. Keep the
            // provider resolver from silently replacing it with a preset
            // default (especially important for MiniMax-M3 pinning).
            judgeModel: definition.model,
          });
      if (!selectedJudge) throw new Error("Unable to resolve a model-judge provider");
      evaluation = await evaluateWithModelJudge(
        rawRun.id,
        rawRun.stdout ?? "",
        definition,
        selectedJudge.judge,
      );
    }
    return createGrade(database, evaluation);
  } finally {
    database.close();
  }
}

function printGrade(result: GradeCommandResult, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify({ grade: result.grade, created: result.created }, null, 2));
    return;
  }

  console.log(`Grade ${result.grade.id}${result.created ? "" : " (existing)"}`);
  console.log(
    `  Run: ${result.grade.raw_run_id} | Grader: ${result.grade.grader_id}@${result.grade.grader_version}`,
  );
  console.log(`  Verdict: ${result.grade.verdict} | Score: ${result.grade.score}`);
}

/** Register `j-rig grade`, the named immutable-grader surface. */
export function registerGradeCommand(program: Command): void {
  program
    .command("grade")
    .description("Grade a completed raw Run with a named immutable grader snapshot")
    .requiredOption("--run-id <id>", "Raw Run id")
    .option("--grader <path>", "YAML grader definition")
    .option("--scripted-import <path>", "Authored import package bound to this stored Run")
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--regrade", "Allow a new grader version to coexist with an earlier Grade")
    .option("--provider <name>", "Model-judge provider (e.g. minimax, anthropic, stub)")
    .option("--json", "Output the Grade as JSON")
    .action(
      async (opts: {
        runId: string;
        grader?: string;
        scriptedImport?: string;
        db: string;
        provider?: string;
        regrade?: boolean;
        json?: boolean;
      }) => {
        try {
          const result = await runGrade({
            runId: opts.runId,
            graderPath: opts.grader,
            scriptedImportPath: opts.scriptedImport,
            db: opts.db,
            regrade: opts.regrade === true,
            provider: opts.provider,
          });
          printGrade(result, opts.json);
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      },
    );
}
