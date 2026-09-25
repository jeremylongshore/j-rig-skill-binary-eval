import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  EvalIdentifierSchema,
  hashGraderSnapshot,
  parseAndValidateYaml,
  planBalancedSamples,
  renderUnifiedReportHtml,
  renderUnifiedReportMarkdown,
  type BalancedSamplingPlan,
  type EvalConfig,
  type EvalTask,
  type SamplingCell,
  type UnifiedReport,
} from "@j-rig/core";
import { deriveRawRunId, getRawRunSampleObservations } from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { loadGraderDefinition, runGrade } from "./grade.js";
import { runGenericEval, loadConfigDefinition, loadTaskDefinition } from "./run.js";
import { runUnifiedReport } from "./report.js";
import { startReportServer, waitForReportServer } from "../lib/report-server.js";

/** The manifest contract for one generic Task × Config evaluation suite. */
export const SuiteDefinitionSchema = z
  .object({
    schema: z.literal("j-rig/eval-suite/v1"),
    id: EvalIdentifierSchema,
    version: z.string().min(1).default("1"),
    description: z.string().min(1).optional(),
    tasks: z.array(z.string().min(1)).min(1),
    configs: z.array(z.string().min(1)).min(1),
    grader: z.string().min(1),
    target_n: z.number().int().positive(),
  })
  .strict();

export type SuiteDefinition = z.infer<typeof SuiteDefinitionSchema>;

type SuiteJobStatus = "planned" | "running" | "completed" | "runner_error" | "timed_out" | "failed";

export interface SuiteJob {
  pass_index: number;
  sample_index: number;
  task_id: string;
  task_version: string;
  config_id: string;
  config_version: string;
  model: string;
  task_path: string;
  config_path: string;
  raw_run_id: string;
  status: SuiteJobStatus;
  reused?: boolean;
  grade?: {
    id: string;
    grader_id: string;
    grader_version: string;
    grader_snapshot_sha256: string;
    verdict: "pass" | "fail";
    score: number;
    created: boolean;
  };
  error?: string;
}

export interface SuiteReportDocument {
  schema: "j-rig/suite-report/v1";
  suite_id: string;
  suite_version: string;
  manifest_path: string;
  generated_at: string;
  raw_run_ids: string[];
  report: UnifiedReport;
}

export interface SuiteAuditManifest {
  schema: "j-rig/eval-suite/v1";
  suite_id: string;
  suite_version: string;
  manifest_path: string;
  database: string;
  output_dir: string;
  target_n: number;
  tasks: Array<{ path: string; id: string; version: string }>;
  configs: Array<{ path: string; id: string; version: string; model: string }>;
  grader: {
    path: string;
    id: string;
    version: string;
    snapshot_sha256: string;
  };
  generated_at: string;
  completed_at: string | null;
  summary: {
    cell_count: number;
    target_n: number;
    attempted: number;
    completed: number;
    harness_failures: number;
    failed: number;
    graded: number;
    reused: number;
    pending: number;
  };
  cells: BalancedSamplingPlan["cells"];
  jobs: SuiteJob[];
  report?: {
    json_path: string;
    markdown_path: string;
    html_path: string;
    raw_run_count: number;
  };
}

export interface SuiteOptions {
  manifestPath: string;
  db: string;
  outputDir?: string;
  targetN?: number;
  regrade?: boolean;
  serve?: boolean;
  host?: string;
  port?: number;
}

export interface SuiteResult {
  audit: SuiteAuditManifest;
  auditPath: string;
  report?: SuiteReportDocument;
}

interface LoadedTask {
  path: string;
  definition: EvalTask;
  index: number;
}

interface LoadedConfig {
  path: string;
  definition: EvalConfig;
  index: number;
}

interface LoadedSuite {
  manifestPath: string;
  definition: SuiteDefinition;
  tasks: LoadedTask[];
  configs: LoadedConfig[];
  graderPath: string;
  grader: ReturnType<typeof loadGraderDefinition>;
  cells: SamplingCell[];
  taskByIdentity: Map<string, LoadedTask>;
  configByIdentity: Map<string, LoadedConfig>;
}

function identity(id: string, version: string): string {
  return `${id}@${version}`;
}

function formatManifestErrors(errors: Array<{ path: string; message: string }>): string {
  return errors
    .map((error) => {
      const field = error.path ? `suite.${error.path}` : "suite";
      return `${field}: ${error.message}`;
    })
    .join("; ");
}

function loadSuiteManifest(manifestPath: string): SuiteDefinition {
  let content: string;
  try {
    content = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new Error(
      `Suite manifest not found or unreadable at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseAndValidateYaml(content, SuiteDefinitionSchema);
  if (!parsed.success) {
    throw new Error(
      `Invalid suite manifest at ${manifestPath}: ${formatManifestErrors(parsed.errors)}`,
    );
  }
  return parsed.data;
}

function resolveSuitePath(
  manifestPath: string,
  field: "tasks" | "configs" | "grader",
  index: number | undefined,
  rawPath: string,
): string {
  const absolutePath = resolve(dirname(manifestPath), rawPath);
  const label = index === undefined ? `suite.${field}` : `suite.${field}.${index}`;
  if (!existsSync(absolutePath)) {
    throw new Error(`${label} path not found: ${absolutePath}`);
  }
  return absolutePath;
}

function loadSuiteDefinition(manifestPathInput: string): LoadedSuite {
  const manifestPath = resolve(manifestPathInput);
  const definition = loadSuiteManifest(manifestPath);
  const tasks: LoadedTask[] = [];
  const taskByIdentity = new Map<string, LoadedTask>();

  definition.tasks.forEach((rawPath, index) => {
    const path = resolveSuitePath(manifestPath, "tasks", index, rawPath);
    let task: EvalTask;
    try {
      task = loadTaskDefinition(path);
    } catch (error) {
      throw new Error(
        `Invalid suite.tasks.${index} (${path}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const taskEntry = { path, definition: task, index };
    const key = identity(task.id, task.version);
    const previous = taskByIdentity.get(key);
    if (previous) {
      throw new Error(
        `Invalid suite.tasks.${index}: duplicates suite.tasks.${previous.index} identity ${key}`,
      );
    }
    tasks.push(taskEntry);
    taskByIdentity.set(key, taskEntry);
  });

  const configs: LoadedConfig[] = [];
  const configByIdentity = new Map<string, LoadedConfig>();
  definition.configs.forEach((rawPath, index) => {
    const path = resolveSuitePath(manifestPath, "configs", index, rawPath);
    let config: EvalConfig;
    try {
      config = loadConfigDefinition(path);
    } catch (error) {
      throw new Error(
        `Invalid suite.configs.${index} (${path}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const configEntry = { path, definition: config, index };
    const key = identity(config.id, config.version);
    const previous = configByIdentity.get(key);
    if (previous) {
      throw new Error(
        `Invalid suite.configs.${index}: duplicates suite.configs.${previous.index} identity ${key}`,
      );
    }
    configs.push(configEntry);
    configByIdentity.set(key, configEntry);
  });

  const graderPath = resolveSuitePath(manifestPath, "grader", undefined, definition.grader);
  let grader: ReturnType<typeof loadGraderDefinition>;
  try {
    grader = loadGraderDefinition(graderPath);
  } catch (error) {
    throw new Error(
      `Invalid suite.grader (${graderPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const cells: SamplingCell[] = [];
  const cellLocations = new Map<string, string>();
  for (const task of tasks) {
    for (const config of configs) {
      const cell: SamplingCell = {
        task_id: task.definition.id,
        task_version: task.definition.version,
        config_id: config.definition.id,
        config_version: config.definition.version,
        model: config.definition.model,
      };
      const key = JSON.stringify(cell);
      const location = `suite.tasks.${task.index} × suite.configs.${config.index}`;
      const previous = cellLocations.get(key);
      if (previous) {
        throw new Error(`Invalid ${location}: duplicates ${previous} cell`);
      }
      cells.push(cell);
      cellLocations.set(key, location);
    }
  }

  return {
    manifestPath,
    definition,
    tasks,
    configs,
    graderPath,
    grader,
    cells,
    taskByIdentity,
    configByIdentity,
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

function readExistingAudit(
  path: string,
  loaded: LoadedSuite,
  targetN: number,
  databasePath: string,
  outputDir: string,
): SuiteAuditManifest | null {
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid suite audit at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid suite audit at ${path}: expected a JSON object`);
  }
  const audit = parsed as Partial<SuiteAuditManifest>;
  if (audit.schema !== "j-rig/eval-suite/v1") {
    throw new Error(`Invalid suite audit at ${path}: schema must be j-rig/eval-suite/v1`);
  }
  if (audit.suite_id !== loaded.definition.id) {
    throw new Error(
      `Suite audit ${path} belongs to suite ${String(audit.suite_id)}; expected ${loaded.definition.id}`,
    );
  }
  if (audit.suite_version !== loaded.definition.version) {
    throw new Error(
      `Suite audit ${path} is version ${String(audit.suite_version)}; expected ${loaded.definition.version}`,
    );
  }
  if (audit.manifest_path !== loaded.manifestPath) {
    throw new Error(
      `Suite audit ${path} belongs to manifest ${String(audit.manifest_path)}; expected ${loaded.manifestPath}`,
    );
  }
  if (audit.target_n !== targetN) {
    throw new Error(
      `Suite audit ${path} targets N=${String(audit.target_n)}; pass the same target or choose a new --output-dir`,
    );
  }
  if (audit.database !== databasePath) {
    throw new Error(
      `Suite audit ${path} uses database ${String(audit.database)}; expected ${databasePath}`,
    );
  }
  if (audit.output_dir !== outputDir) {
    throw new Error(
      `Suite audit ${path} uses output directory ${String(audit.output_dir)}; expected ${outputDir}`,
    );
  }
  if (!Array.isArray(audit.jobs) || !Array.isArray(audit.cells)) {
    throw new Error(`Invalid suite audit at ${path}: jobs and cells must be arrays`);
  }
  return audit as SuiteAuditManifest;
}

function initialAudit(
  loaded: LoadedSuite,
  database: string,
  outputDir: string,
  targetN: number,
  plan: BalancedSamplingPlan,
): SuiteAuditManifest {
  return {
    schema: "j-rig/eval-suite/v1",
    suite_id: loaded.definition.id,
    suite_version: loaded.definition.version,
    manifest_path: loaded.manifestPath,
    database,
    output_dir: outputDir,
    target_n: targetN,
    tasks: loaded.tasks.map((task) => ({
      path: task.path,
      id: task.definition.id,
      version: task.definition.version,
    })),
    configs: loaded.configs.map((config) => ({
      path: config.path,
      id: config.definition.id,
      version: config.definition.version,
      model: config.definition.model,
    })),
    grader: {
      path: loaded.graderPath,
      id: loaded.grader.id,
      version: loaded.grader.version,
      snapshot_sha256: hashGraderSnapshot(loaded.grader),
    },
    generated_at: new Date().toISOString(),
    completed_at: null,
    summary: {
      cell_count: loaded.cells.length,
      target_n: targetN,
      attempted: 0,
      completed: 0,
      harness_failures: 0,
      failed: 0,
      graded: 0,
      reused: 0,
      pending: plan.jobs.length,
    },
    cells: plan.cells,
    jobs: [],
  };
}

function summarizeAudit(audit: SuiteAuditManifest, plan: BalancedSamplingPlan): void {
  const terminalJobs = audit.jobs.filter(
    (job) => job.status !== "planned" && job.status !== "running",
  );
  audit.summary = {
    cell_count: audit.cells.length,
    target_n: audit.target_n,
    attempted: terminalJobs.length,
    completed: audit.jobs.filter((job) => job.status === "completed").length,
    harness_failures: audit.jobs.filter(
      (job) => job.status === "runner_error" || job.status === "timed_out",
    ).length,
    failed: audit.jobs.filter((job) => job.status === "failed").length,
    graded: audit.jobs.filter((job) => job.grade !== undefined).length,
    reused: audit.jobs.filter((job) => job.reused === true).length,
    pending: plan.jobs.length,
  };
  audit.cells = plan.cells;
}

function planSuite(
  loaded: LoadedSuite,
  databasePath: string,
  targetN: number,
): BalancedSamplingPlan {
  const database = openDb(databasePath);
  try {
    return planBalancedSamples({
      cells: loaded.cells,
      existing_runs: getRawRunSampleObservations(database),
      target_n: targetN,
    });
  } finally {
    database.close();
  }
}

function jobFromPlan(job: BalancedSamplingPlan["jobs"][number], loaded: LoadedSuite): SuiteJob {
  const task = loaded.taskByIdentity.get(identity(job.task_id, job.task_version));
  const config = loaded.configByIdentity.get(identity(job.config_id, job.config_version));
  if (!task || !config) {
    throw new Error(
      `Suite plan references an unknown cell: ${job.task_id}@${job.task_version} / ${job.config_id}@${job.config_version}`,
    );
  }
  return {
    ...job,
    task_path: task.path,
    config_path: config.path,
    raw_run_id: deriveRawRunId(job),
    status: "planned",
  };
}

function addPlannedJobs(
  audit: SuiteAuditManifest,
  plan: BalancedSamplingPlan,
  loaded: LoadedSuite,
): SuiteJob[] {
  const added: SuiteJob[] = [];
  const byRunId = new Map(audit.jobs.map((job) => [job.raw_run_id, job]));
  for (const planned of plan.jobs) {
    const candidate = jobFromPlan(planned, loaded);
    const existing = byRunId.get(candidate.raw_run_id);
    if (existing) {
      if (existing.status === "failed") {
        existing.status = "planned";
        delete existing.error;
      }
      if (existing.status === "planned" || existing.status === "running") added.push(existing);
      continue;
    }
    audit.jobs.push(candidate);
    byRunId.set(candidate.raw_run_id, candidate);
    added.push(candidate);
  }
  return added;
}

function gradeSnapshot(
  result: Awaited<ReturnType<typeof runGrade>>,
): NonNullable<SuiteJob["grade"]> {
  return {
    id: result.grade.id,
    grader_id: result.grade.grader_id,
    grader_version: result.grade.grader_version,
    grader_snapshot_sha256: result.grade.grader_snapshot_sha256,
    verdict: result.grade.verdict,
    score: result.grade.score,
    created: result.created,
  };
}

async function executeJob(
  job: SuiteJob,
  audit: SuiteAuditManifest,
  loaded: LoadedSuite,
  regrade: boolean,
  auditPath: string,
): Promise<void> {
  job.status = "running";
  writeJsonAtomic(auditPath, audit);
  try {
    const result = await runGenericEval({
      taskPath: job.task_path,
      configPath: job.config_path,
      db: audit.database,
      sampleIndex: job.sample_index,
    });
    job.raw_run_id = result.run.id;
    job.reused = result.reused;
    if (result.run.status === "completed") {
      const grade = await runGrade({
        runId: result.run.id,
        graderPath: loaded.graderPath,
        db: audit.database,
        regrade,
      });
      job.status = "completed";
      job.grade = gradeSnapshot(grade);
      delete job.error;
    } else if (result.run.status === "runner_error" || result.run.status === "timed_out") {
      job.status = result.run.status;
      job.error = result.run.error_message ?? result.run.stderr ?? undefined;
      delete job.grade;
    } else {
      job.status = "failed";
      job.error = `Raw Run ${result.run.id} remained ${result.run.status}`;
      delete job.grade;
    }
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
  }
  writeJsonAtomic(auditPath, audit);
}

function suiteReport(
  audit: SuiteAuditManifest,
  jsonPath: string,
  markdownPath: string,
  htmlPath: string,
): SuiteReportDocument | undefined {
  const grade = audit.jobs.find((job) => job.grade)?.grade;
  if (!grade) return undefined;

  const rawRunIds = audit.jobs.map((job) => job.raw_run_id);
  const unified = runUnifiedReport({
    db: audit.database,
    graderId: grade.grader_id,
    graderVersion: grade.grader_version,
    graderSnapshotSha256: grade.grader_snapshot_sha256,
    runIds: rawRunIds,
    json: true,
  });
  const document: SuiteReportDocument = {
    schema: "j-rig/suite-report/v1",
    suite_id: audit.suite_id,
    suite_version: audit.suite_version,
    manifest_path: audit.manifest_path,
    generated_at: new Date().toISOString(),
    raw_run_ids: rawRunIds,
    report: unified.report,
  };
  writeJsonAtomic(jsonPath, document);
  const markdown = [
    "# J-Rig Suite Report",
    "",
    `- Schema: \`${document.schema}\``,
    `- Suite: \`${document.suite_id}@${document.suite_version}\``,
    `- Manifest: \`${document.manifest_path}\``,
    `- Raw Runs: ${document.raw_run_ids.length}`,
    "",
    renderUnifiedReportMarkdown(unified.report),
  ].join("\n");
  writeFileSync(markdownPath, markdown, "utf8");
  writeFileSync(
    htmlPath,
    renderUnifiedReportHtml(unified.report, {
      title: `J-Rig Suite Report — ${audit.suite_id}@${audit.suite_version}`,
    }),
    "utf8",
  );
  audit.report = {
    json_path: jsonPath,
    markdown_path: markdownPath,
    html_path: htmlPath,
    raw_run_count: rawRunIds.length,
  };
  return document;
}

/** Execute one manifest-defined Task × Config suite and persist resumable audit state. */
export async function runSuite(options: SuiteOptions): Promise<SuiteResult> {
  const loaded = loadSuiteDefinition(options.manifestPath);
  const targetN = options.targetN ?? loaded.definition.target_n;
  if (!Number.isInteger(targetN) || targetN < 1) {
    throw new Error(`suite.target_n must be a positive integer (got ${targetN})`);
  }

  const database = resolve(options.db);
  const outputDir = resolve(options.outputDir ?? join(".j-rig", "suites", loaded.definition.id));
  const auditPath = join(outputDir, "manifest.json");
  const jsonReportPath = join(outputDir, "report.json");
  const markdownReportPath = join(outputDir, "report.md");
  const htmlReportPath = join(outputDir, "report.html");
  let plan = planSuite(loaded, database, targetN);
  const audit =
    readExistingAudit(auditPath, loaded, targetN, database, outputDir) ??
    initialAudit(loaded, database, outputDir, targetN, plan);
  audit.database = database;
  audit.output_dir = outputDir;

  if (audit.jobs.length === 0 && plan.jobs.length > 0) {
    addPlannedJobs(audit, plan, loaded);
  }

  // Recover jobs left planned/running by an interrupted process before adding
  // fresh top-ups. Raw Run identity makes this replay safe and idempotent.
  const recoveryJobs = audit.jobs.filter(
    (job) =>
      job.status === "planned" ||
      job.status === "running" ||
      (job.status === "completed" && job.grade === undefined),
  );
  for (const job of recoveryJobs) {
    await executeJob(job, audit, loaded, options.regrade === true, auditPath);
  }

  plan = planSuite(loaded, database, targetN);
  const newJobs = addPlannedJobs(audit, plan, loaded);
  for (const job of newJobs) {
    if (job.status === "planned" || job.status === "running") {
      await executeJob(job, audit, loaded, options.regrade === true, auditPath);
    }
  }

  plan = planSuite(loaded, database, targetN);
  summarizeAudit(audit, plan);
  audit.completed_at = new Date().toISOString();
  const report = suiteReport(audit, jsonReportPath, markdownReportPath, htmlReportPath);
  writeJsonAtomic(auditPath, audit);
  return { audit, auditPath, ...(report ? { report } : {}) };
}

function printSuite(result: SuiteResult, json?: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          ...result.audit,
          audit_path: result.auditPath,
          report_path: result.audit.report?.json_path,
          report_html_path: result.audit.report?.html_path,
        },
        null,
        2,
      ),
    );
    return;
  }
  const summary = result.audit.summary;
  console.log(`Suite ${result.audit.suite_id}@${result.audit.suite_version}`);
  console.log(
    `  ${summary.completed} completed / ${summary.graded} graded / ${summary.harness_failures} harness failures / ${summary.failed} failed`,
  );
  console.log(`  Cells: ${summary.cell_count} | Target N: ${summary.target_n}`);
  console.log(`  Pending top-ups: ${summary.pending}`);
  console.log(`  Audit: ${result.auditPath}`);
  if (result.audit.report) {
    console.log(`  Report: ${result.audit.report.markdown_path}`);
    console.log(`  HTML: ${result.audit.report.html_path}`);
  }
}

/** Register `j-rig suite`, the generic resumable suite lifecycle. */
export function registerSuiteCommand(program: Command): void {
  program
    .command("suite")
    .description("Execute a manifest-defined Task × Config suite with balanced target-N sampling")
    .argument("<manifest>", "YAML suite manifest")
    .option("--db <path>", "SQLite raw-run evidence store", "j-rig.db")
    .option("--output-dir <path>", "Suite audit/report directory")
    .option("--target-n <n>", "Override manifest target_n", (value: string) => Number(value))
    .option("--regrade", "Allow a changed grader snapshot to coexist with an earlier Grade")
    .option("--serve", "Serve the generated HTML report on loopback until interrupted")
    .option("--host <host>", "Loopback bind address for --serve", "127.0.0.1")
    .option("--port <n>", "TCP port for --serve (0 chooses an available port)", parseInt, 0)
    .option("--json", "Output the suite audit manifest as JSON")
    .action(
      async (
        manifest: string,
        opts: {
          db: string;
          outputDir?: string;
          targetN?: number;
          regrade?: boolean;
          serve?: boolean;
          host: string;
          port: number;
          json?: boolean;
        },
      ) => {
        try {
          if (opts.serve && opts.json) {
            throw new Error("--serve and --json are mutually exclusive");
          }
          const result = await runSuite({
            manifestPath: manifest,
            db: opts.db,
            outputDir: opts.outputDir,
            targetN: opts.targetN,
            regrade: opts.regrade === true,
          });
          printSuite(result, opts.json);
          if (opts.serve) {
            const htmlPath = result.audit.report?.html_path;
            if (!result.report?.report || !htmlPath) {
              throw new Error("--serve requires a generated suite HTML report");
            }
            const html = await readFile(htmlPath, "utf8");
            const server = await startReportServer(html, {
              host: opts.host,
              port: opts.port,
            });
            console.error(`Serving report at ${server.url} (Ctrl-C to stop)`);
            await waitForReportServer(server);
          }
          if (result.audit.summary.pending > 0 || result.audit.summary.failed > 0) {
            process.exitCode = 1;
          }
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      },
    );
}
