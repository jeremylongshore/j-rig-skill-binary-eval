import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { runGenericEval } from "./run.js";
import { runSuite } from "./suite.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(failingCell = false) {
  const dir = mkdtempSync(join(tmpdir(), "j-rig-suite-"));
  tempDirs.push(dir);
  const tasksDir = join(dir, "tasks");
  const configsDir = join(dir, "configs");
  const graderPath = join(dir, "grader.yaml");
  const manifestPath = join(dir, "suite.yaml");
  const dbPath = join(dir, "runs.db");
  const outputDir = join(dir, "suite-output");

  const taskA = join(tasksDir, "task-a.yaml");
  const taskB = join(tasksDir, "task-b.yaml");
  const configA = join(configsDir, "config-a.yaml");
  const configB = join(configsDir, "config-b.yaml");

  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(configsDir, { recursive: true });

  const harness = [
    "let body = '';",
    "process.stdin.on('data', chunk => body += chunk);",
    "process.stdin.on('end', () => {",
    "  const request = JSON.parse(body);",
    failingCell
      ? "  if (request.task.id === 'task-b' && request.config.id === 'config-b') { process.stderr.write('fixture failure'); process.exit(9); }"
      : "",
    "  process.stdout.write(`ok:${request.task.id}:${request.config.id}`);",
    "});",
  ]
    .filter(Boolean)
    .join(" ");

  writeFileSync(taskA, stringify({ id: "task-a", version: "1", input: { value: "a" } }), "utf8");
  writeFileSync(taskB, stringify({ id: "task-b", version: "1", input: { value: "b" } }), "utf8");
  writeFileSync(
    configA,
    stringify({
      id: "config-a",
      version: "1",
      model: "model-a",
      harness: { command: process.execPath, args: ["-e", harness], timeout_ms: 2_000 },
    }),
    "utf8",
  );
  writeFileSync(
    configB,
    stringify({
      id: "config-b",
      version: "1",
      model: "model-b",
      harness: { command: process.execPath, args: ["-e", harness], timeout_ms: 2_000 },
    }),
    "utf8",
  );
  writeFileSync(
    graderPath,
    stringify({
      id: "output-checker",
      version: "1.0.0",
      kind: "deterministic",
      checks: [{ id: "has-ok", type: "output_contains", expected: "ok" }],
    }),
    "utf8",
  );
  writeFileSync(
    manifestPath,
    stringify({
      schema: "j-rig/eval-suite/v1",
      id: "four-cell-suite",
      version: "1",
      tasks: ["tasks/task-a.yaml", "tasks/task-b.yaml"],
      configs: ["configs/config-a.yaml", "configs/config-b.yaml"],
      grader: "grader.yaml",
      target_n: 2,
    }),
    "utf8",
  );

  return { manifestPath, dbPath, outputDir, taskA, configA };
}

describe("j-rig suite", () => {
  it("executes a balanced two-task/two-config target and resumes without duplicate work", async () => {
    const paths = fixture();
    const first = await runSuite({
      manifestPath: paths.manifestPath,
      db: paths.dbPath,
      outputDir: paths.outputDir,
    });

    expect(first.audit.cells).toHaveLength(4);
    expect(first.audit.jobs).toHaveLength(8);
    expect(first.audit.jobs.every((job) => job.status === "completed")).toBe(true);
    expect(first.audit.jobs.every((job) => job.grade?.grader_id === "output-checker")).toBe(true);
    expect(first.audit.summary.pending).toBe(0);
    expect(first.report?.schema).toBe("j-rig/suite-report/v1");
    expect(first.report?.report.summary.cell_count).toBe(4);
    expect(first.report?.report.runs).toHaveLength(8);

    // A shared DB may contain unrelated generic runs. The suite report must
    // retain only the raw Run ids named by this suite's audit.
    await runGenericEval({
      taskPath: paths.taskA,
      configPath: paths.configA,
      db: paths.dbPath,
      sampleIndex: 99,
    });

    const second = await runSuite({
      manifestPath: paths.manifestPath,
      db: paths.dbPath,
      outputDir: paths.outputDir,
    });
    expect(second.audit.jobs).toHaveLength(8);
    expect(second.audit.summary.pending).toBe(0);
    expect(second.audit.jobs.map((job) => job.raw_run_id)).toEqual(
      first.audit.jobs.map((job) => job.raw_run_id),
    );
    expect(second.report?.report.runs).toHaveLength(8);
    expect(second.report?.report.summary.ungraded_completed_runs).toBe(0);
    expect(JSON.parse(readFileSync(join(paths.outputDir, "manifest.json"), "utf8")).schema).toBe(
      "j-rig/eval-suite/v1",
    );
  });

  it("retains runner failures as ungraded observations and leaves a top-up pending", async () => {
    const paths = fixture(true);
    const result = await runSuite({
      manifestPath: paths.manifestPath,
      db: paths.dbPath,
      outputDir: paths.outputDir,
      targetN: 1,
    });

    expect(result.audit.summary.harness_failures).toBe(2);
    expect(result.audit.summary.completed).toBe(3);
    expect(result.audit.summary.graded).toBe(3);
    expect(result.audit.summary.pending).toBe(1);
    const failed = result.audit.jobs.find((job) => job.status === "runner_error");
    expect(failed?.grade).toBeUndefined();
    expect(result.report?.report.summary.harness_failure_count).toBe(2);
    expect(result.report?.report.summary.ungraded_completed_runs).toBe(0);
  });

  it("reports manifest-relative path failures with the exact suite field", async () => {
    const paths = fixture();
    writeFileSync(
      paths.manifestPath,
      stringify({
        schema: "j-rig/eval-suite/v1",
        id: "four-cell-suite",
        tasks: ["tasks/task-a.yaml"],
        configs: ["configs/config-a.yaml", "configs/missing.yaml"],
        grader: "grader.yaml",
        target_n: 1,
      }),
      "utf8",
    );

    await expect(
      runSuite({ manifestPath: paths.manifestPath, db: paths.dbPath, outputDir: paths.outputDir }),
    ).rejects.toThrow("suite.configs.1 path not found");
  });
});

describe("j-rig suite — fail-closed manifest and resume guards", () => {
  function rewriteManifest(path: string, patch: Record<string, unknown>): void {
    const current = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, stringify({ ...current, ...patch }), "utf8");
  }

  function rewriteAudit(outputDir: string, patch: Record<string, unknown>): void {
    const auditPath = join(outputDir, "manifest.json");
    const current = JSON.parse(readFileSync(auditPath, "utf8")) as Record<string, unknown>;
    writeFileSync(auditPath, JSON.stringify({ ...current, ...patch }), "utf8");
  }

  it("names the manifest path when the suite file is missing or fails its schema", async () => {
    const paths = fixture();
    const missing = join(paths.outputDir, "absent.yaml");
    await expect(runSuite({ manifestPath: missing, db: paths.dbPath })).rejects.toThrow(
      `Suite manifest not found or unreadable at ${missing}`,
    );

    rewriteManifest(paths.manifestPath, { tasks: [] });
    await expect(
      runSuite({ manifestPath: paths.manifestPath, db: paths.dbPath, outputDir: paths.outputDir }),
    ).rejects.toThrow(`Invalid suite manifest at ${paths.manifestPath}`);
  });

  it("rejects duplicate task and config identities with both manifest positions", async () => {
    const tasks = fixture();
    rewriteManifest(tasks.manifestPath, {
      tasks: ["tasks/task-a.yaml", "tasks/task-b.yaml", "tasks/task-a.yaml"],
    });
    await expect(
      runSuite({ manifestPath: tasks.manifestPath, db: tasks.dbPath, outputDir: tasks.outputDir }),
    ).rejects.toThrow("Invalid suite.tasks.2: duplicates suite.tasks.0 identity");

    const configs = fixture();
    rewriteManifest(configs.manifestPath, {
      configs: ["configs/config-a.yaml", "configs/config-a.yaml"],
    });
    await expect(
      runSuite({
        manifestPath: configs.manifestPath,
        db: configs.dbPath,
        outputDir: configs.outputDir,
      }),
    ).rejects.toThrow("Invalid suite.configs.1: duplicates suite.configs.0 identity");
  });

  it("attributes an invalid config or grader file to its exact suite field", async () => {
    const config = fixture();
    writeFileSync(config.configA, stringify({ id: "config-a" }), "utf8");
    await expect(
      runSuite({
        manifestPath: config.manifestPath,
        db: config.dbPath,
        outputDir: config.outputDir,
      }),
    ).rejects.toThrow(`Invalid suite.configs.0 (${config.configA})`);

    const grader = fixture();
    const graderPath = join(dirname(grader.manifestPath), "grader.yaml");
    writeFileSync(graderPath, stringify({ id: "output-checker" }), "utf8");
    await expect(
      runSuite({
        manifestPath: grader.manifestPath,
        db: grader.dbPath,
        outputDir: grader.outputDir,
      }),
    ).rejects.toThrow(`Invalid suite.grader (${graderPath})`);
  });

  it("rejects a non-positive target before planning any work", async () => {
    const paths = fixture();
    await expect(
      runSuite({
        manifestPath: paths.manifestPath,
        db: paths.dbPath,
        outputDir: paths.outputDir,
        targetN: 0,
      }),
    ).rejects.toThrow("suite.target_n must be a positive integer (got 0)");
  });

  it("refuses to resume into an audit that is corrupt or belongs to a different run", async () => {
    const paths = fixture();
    const options = {
      manifestPath: paths.manifestPath,
      db: paths.dbPath,
      outputDir: paths.outputDir,
    };
    const first = await runSuite(options);
    const original = readFileSync(first.auditPath, "utf8");
    const restore = (): void => writeFileSync(first.auditPath, original, "utf8");

    await expect(runSuite({ ...options, targetN: 3 })).rejects.toThrow(
      "targets N=2; pass the same target or choose a new --output-dir",
    );
    await expect(runSuite({ ...options, db: join(paths.outputDir, "other.db") })).rejects.toThrow(
      `uses database ${paths.dbPath}`,
    );

    const mismatches: Array<[Record<string, unknown>, string]> = [
      [{ schema: "j-rig/eval-suite/v0" }, "schema must be j-rig/eval-suite/v1"],
      [{ suite_id: "another-suite" }, "belongs to suite another-suite; expected four-cell-suite"],
      [{ suite_version: "9" }, "is version 9; expected 1"],
      [{ manifest_path: "/elsewhere/suite.yaml" }, "belongs to manifest /elsewhere/suite.yaml"],
      [{ output_dir: "/elsewhere/out" }, "uses output directory /elsewhere/out"],
      [{ jobs: "not-an-array" }, "jobs and cells must be arrays"],
    ];
    for (const [patch, message] of mismatches) {
      rewriteAudit(paths.outputDir, patch);
      await expect(runSuite(options)).rejects.toThrow(message);
      restore();
    }

    writeFileSync(first.auditPath, "{ not json", "utf8");
    await expect(runSuite(options)).rejects.toThrow(`Invalid suite audit at ${first.auditPath}`);
    writeFileSync(first.auditPath, "null", "utf8");
    await expect(runSuite(options)).rejects.toThrow("expected a JSON object");

    restore();
    const resumed = await runSuite(options);
    expect(resumed.audit.jobs).toHaveLength(8);
    expect(resumed.audit.summary.pending).toBe(0);
  });
});
