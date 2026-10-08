import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { getGradesForRun, getRawRun } from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { runGenericEval } from "./run.js";
import { registerGradeCommand, runGrade } from "./grade.js";

// Fixtures spawn a real harness child process per Run.
vi.setConfig({ testTimeout: 30_000 });

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "j-rig-grade-"));
  tempDirs.push(dir);
  const taskPath = join(dir, "task.yaml");
  const configPath = join(dir, "config.yaml");
  const graderV1Path = join(dir, "grader-v1.yaml");
  const graderV2Path = join(dir, "grader-v2.yaml");
  const modelGraderPath = join(dir, "grader-model.yaml");
  const db = join(dir, "runs.db");

  writeFileSync(
    taskPath,
    stringify({ id: "answer-task", version: "1", input: { question: "2+2" } }),
  );
  writeFileSync(
    configPath,
    stringify({
      id: "fixture-config",
      version: "1",
      model: "fixture-model",
      harness: {
        command: process.execPath,
        args: ["-e", 'process.stdout.write("The answer is 4 because arithmetic.");'],
      },
    }),
  );
  writeFileSync(
    graderV1Path,
    stringify({
      id: "answer-checker",
      version: "1.0.0",
      kind: "deterministic",
      checks: [{ id: "has-answer", type: "output_contains", expected: "4" }],
    }),
  );
  writeFileSync(
    graderV2Path,
    stringify({
      id: "answer-checker",
      version: "2.0.0",
      kind: "deterministic",
      checks: [
        { id: "has-answer", type: "output_contains", expected: "4" },
        { id: "has-explanation", type: "output_contains", expected: "because" },
      ],
    }),
  );
  writeFileSync(
    modelGraderPath,
    stringify({
      id: "quality-judge",
      version: "1.0.0",
      kind: "model_judge",
      model: "fixture-judge",
      criterion_description: "The output is correct",
      judge_prompt: "Answer yes only when the output is correct.",
      samples: 3,
    }),
  );
  return { taskPath, configPath, graderV1Path, graderV2Path, modelGraderPath, db };
}

describe("j-rig grade", () => {
  it("reuses a saved model Grade before provider resolution or further judge calls", async () => {
    const paths = fixture();
    const raw = await runGenericEval({ ...paths, sampleIndex: 0 });
    const judge = {
      judge: vi.fn(async () => ({
        verdict: "yes" as const,
        confidence: 1,
        reasoning: "fixture judgment",
      })),
    };
    const options = {
      runId: raw.run.id,
      graderPath: paths.modelGraderPath,
      db: paths.db,
      regrade: false,
    };
    const first = await runGrade({ ...options, judge });
    expect(judge.judge).toHaveBeenCalledTimes(3);

    expect(await runGrade({ ...options, judge })).toEqual({ ...first, created: false });
    expect(judge.judge).toHaveBeenCalledTimes(3);
    // A cache hit must work even without a resolvable provider or credentials.
    expect(await runGrade({ ...options, provider: "unavailable-fixture", regrade: true })).toEqual({
      ...first,
      created: false,
    });
  });

  it("checks changed-snapshot policy before spending judge calls", async () => {
    const paths = fixture();
    const raw = await runGenericEval({ ...paths, sampleIndex: 0 });
    const judge = {
      judge: vi.fn(async () => ({
        verdict: "yes" as const,
        confidence: 1,
        reasoning: "fixture judgment",
      })),
    };
    const options = {
      runId: raw.run.id,
      graderPath: paths.modelGraderPath,
      db: paths.db,
      regrade: false,
      judge,
    };
    const first = await runGrade(options);
    const definition = parse(readFileSync(paths.modelGraderPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      paths.modelGraderPath,
      stringify({ ...definition, judge_prompt: "Apply a different grading rule." }),
    );

    await expect(runGrade(options)).rejects.toThrow("pass --regrade");
    expect(judge.judge).toHaveBeenCalledTimes(3);
    const second = await runGrade({ ...options, regrade: true });
    expect(judge.judge).toHaveBeenCalledTimes(6);
    expect(second.created).toBe(true);
    expect(second.grade.id).not.toBe(first.grade.id);
    const database = openDb(paths.db);
    try {
      expect(getGradesForRun(database, raw.run.id)).toHaveLength(2);
      expect(getRawRun(database, raw.run.id)).toEqual(raw.run);
    } finally {
      database.close();
    }
  });

  it("does not store a quality Grade for a dead judge and allows a healthy retry", async () => {
    const paths = fixture();
    const raw = await runGenericEval({ ...paths, sampleIndex: 0 });
    const options = {
      runId: raw.run.id,
      graderPath: paths.modelGraderPath,
      db: paths.db,
      regrade: false,
    };
    await expect(
      runGrade({
        ...options,
        judge: { judge: vi.fn().mockRejectedValue(new Error("fixture provider unavailable")) },
      }),
    ).rejects.toThrow("Model judge failed");
    const database = openDb(paths.db);
    try {
      expect(getGradesForRun(database, raw.run.id)).toEqual([]);
      expect(getRawRun(database, raw.run.id)).toEqual(raw.run);
    } finally {
      database.close();
    }
    const retry = await runGrade({
      ...options,
      judge: {
        async judge() {
          return { verdict: "yes", confidence: 1, reasoning: "fixture recovered" };
        },
      },
    });
    expect(retry.created).toBe(true);
    expect(retry.grade.verdict).toBe("pass");
  });

  it("grades a raw Run and keeps a regrade as a second immutable snapshot", async () => {
    const paths = fixture();
    const raw = await runGenericEval({ ...paths, sampleIndex: 0 });

    const first = await runGrade({
      runId: raw.run.id,
      graderPath: paths.graderV1Path,
      db: paths.db,
      regrade: false,
    });
    const repeat = await runGrade({
      runId: raw.run.id,
      graderPath: paths.graderV1Path,
      db: paths.db,
      regrade: false,
    });
    const second = await runGrade({
      runId: raw.run.id,
      graderPath: paths.graderV2Path,
      db: paths.db,
      regrade: true,
    });
    const repeatV1 = await runGrade({
      runId: raw.run.id,
      graderPath: paths.graderV1Path,
      db: paths.db,
      regrade: false,
    });

    expect(first.created).toBe(true);
    expect(repeat.created).toBe(false);
    expect(first.grade.id).not.toBe(second.grade.id);
    expect(second.grade.grader_version).toBe("2.0.0");
    expect(repeatV1.created).toBe(false);
    expect(repeatV1.grade.id).toBe(first.grade.id);
  });

  it("requires --regrade before changing a grader version", async () => {
    const paths = fixture();
    const raw = await runGenericEval({ ...paths, sampleIndex: 0 });
    await runGrade({
      runId: raw.run.id,
      graderPath: paths.graderV1Path,
      db: paths.db,
      regrade: false,
    });

    await expect(
      runGrade({
        runId: raw.run.id,
        graderPath: paths.graderV2Path,
        db: paths.db,
        regrade: false,
      }),
    ).rejects.toThrow("pass --regrade");
  });

  it("runs a sampled model-judge grader and persists disagreement evidence", async () => {
    const paths = fixture();
    const raw = await runGenericEval({ ...paths, sampleIndex: 0 });
    const votes: Array<"yes" | "no" | "unsure"> = ["yes", "no", "yes"];

    const result = await runGrade({
      runId: raw.run.id,
      graderPath: paths.modelGraderPath,
      db: paths.db,
      regrade: false,
      judge: {
        async judge() {
          return {
            verdict: votes.shift() ?? "unsure",
            confidence: 0.5,
            reasoning: "fixture vote",
          };
        },
      },
    });

    expect(result.created).toBe(true);
    expect(result.grade.grader_kind).toBe("model_judge");
    expect(JSON.parse(result.grade.metadata_json ?? "{}")).toMatchObject({
      judge: {
        raw_verdict: "yes",
        samples: 3,
        agreement: 2 / 3,
        sample_verdicts: ["yes", "no", "yes"],
        disagreement: true,
      },
    });
  });
});

describe("j-rig grade — fail-closed inputs", () => {
  it("refuses an invalid grader definition before opening the database", async () => {
    const paths = fixture();
    const badGrader = join(paths.db, "..", "grader-bad.yaml");
    writeFileSync(badGrader, stringify({ id: "broken", kind: "deterministic" }));
    await expect(
      runGrade({ runId: "any", graderPath: badGrader, db: paths.db, regrade: false }),
    ).rejects.toThrow(/^Invalid grader definition at .*grader-bad\.yaml: /);
    expect(existsSync(paths.db)).toBe(false);
  });

  it("refuses a run id that is not in the evidence store", async () => {
    const paths = fixture();
    await expect(
      runGrade({
        runId: "missing-run",
        graderPath: paths.graderV1Path,
        db: paths.db,
        regrade: false,
      }),
    ).rejects.toThrow("Raw Run missing-run not found");
  });

  it("refuses to grade a Run that did not complete", async () => {
    const paths = fixture();
    const configPath = join(paths.db, "..", "broken-config.yaml");
    writeFileSync(
      configPath,
      stringify({
        id: "broken-config",
        version: "1",
        model: "fixture-model",
        harness: { command: process.execPath, args: ["-e", "process.exit(7)"] },
      }),
    );
    const raw = await runGenericEval({ ...paths, configPath, sampleIndex: 0 });
    expect(raw.run.status).toBe("runner_error");
    await expect(
      runGrade({ runId: raw.run.id, graderPath: paths.graderV1Path, db: paths.db, regrade: false }),
    ).rejects.toThrow(`Raw Run ${raw.run.id} is runner_error; only completed Runs can be graded`);
    const database = openDb(paths.db);
    try {
      expect(getGradesForRun(database, raw.run.id)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("resolves the stub judge by --provider when no judge seam is injected", async () => {
    vi.stubEnv("J_RIG_ALLOW_STUB", "1");
    const paths = fixture();
    const raw = await runGenericEval({ ...paths, sampleIndex: 0 });
    const result = await runGrade({
      runId: raw.run.id,
      graderPath: paths.modelGraderPath,
      db: paths.db,
      regrade: false,
      provider: "stub",
    });
    expect(result.created).toBe(true);
    expect(result.grade.grader_kind).toBe("model_judge");
    expect(result.grade.grader_id).toBe("quality-judge");
  });
});

describe("j-rig grade — registered command output", () => {
  function program(): Command {
    const command = new Command();
    command.exitOverride();
    registerGradeCommand(command);
    return command;
  }

  function captureConsole(): { logs: string[]; errors: string[] } {
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(((...parts: unknown[]) => {
      logs.push(parts.join(" "));
    }) as never);
    vi.spyOn(console, "error").mockImplementation(((...parts: unknown[]) => {
      errors.push(parts.join(" "));
    }) as never);
    return { logs, errors };
  }

  it("prints a new Grade, then marks the identical rerun as existing", async () => {
    const paths = fixture();
    const raw = await runGenericEval({ ...paths, sampleIndex: 0 });
    const { logs } = captureConsole();
    const args = [
      "grade",
      "--run-id",
      raw.run.id,
      "--grader",
      paths.graderV1Path,
      "--db",
      paths.db,
    ];

    await program().parseAsync(args, { from: "user" });
    await program().parseAsync(args, { from: "user" });

    expect(process.exitCode).toBeUndefined();
    const headers = logs.filter((line) => line.startsWith("Grade "));
    expect(headers).toHaveLength(2);
    expect(headers[0]).not.toContain("(existing)");
    expect(headers[1]).toContain("(existing)");
    expect(logs).toContain(`  Run: ${raw.run.id} | Grader: answer-checker@1.0.0`);
    expect(logs.some((line) => line.startsWith("  Verdict: pass | Score: "))).toBe(true);
  });

  it("prints the Grade as JSON with --json", async () => {
    const paths = fixture();
    const raw = await runGenericEval({ ...paths, sampleIndex: 0 });
    const { logs } = captureConsole();
    await program().parseAsync(
      [
        "grade",
        "--run-id",
        raw.run.id,
        "--grader",
        paths.graderV1Path,
        "--db",
        paths.db,
        "--regrade",
        "--json",
      ],
      { from: "user" },
    );
    const printed = JSON.parse(logs.join("\n")) as {
      created: boolean;
      grade: { raw_run_id: string };
    };
    expect(printed.created).toBe(true);
    expect(printed.grade.raw_run_id).toBe(raw.run.id);
  });

  it("prints the error and sets exit code 1 when grading fails", async () => {
    const paths = fixture();
    const { errors } = captureConsole();
    await program().parseAsync(
      ["grade", "--run-id", "missing-run", "--grader", paths.graderV1Path, "--db", paths.db],
      { from: "user" },
    );
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual(["Error: Raw Run missing-run not found"]);
  });

  it("grades a command Run's exit code and stdout JSON with structured checks", async () => {
    const paths = fixture();
    writeFileSync(
      paths.configPath,
      stringify({
        id: "json-cli-config",
        version: "1",
        model: "fixture-model",
        harness: {
          command: process.execPath,
          args: [
            "-e",
            'process.stdout.write(JSON.stringify({status:"ok",pages:12})); process.exitCode = 3;',
          ],
          // Exit 3 is this CLI's answer, not a harness failure.
          completed_exit_codes: [0, 3],
        },
      }),
    );
    const graderPath = join(paths.db, "..", "grader-cli.yaml");
    writeFileSync(
      graderPath,
      stringify({
        id: "cli-checker",
        version: "1.0.0",
        kind: "deterministic",
        checks: [
          { id: "exit-3", type: "exit_code", equals: 3 },
          { id: "status-ok", type: "json_path", path: "$.status", equals: "ok" },
          {
            id: "shape",
            type: "schema_valid",
            schema: {
              type: "object",
              required: ["status", "pages"],
              properties: { pages: { type: "integer", minimum: 1 } },
            },
          },
          {
            id: "no-artifact",
            type: "file_sha256",
            path: "out.pdf",
            sha256: "a".repeat(64),
            required: false,
          },
        ],
      }),
    );
    const raw = await runGenericEval({ ...paths, sampleIndex: 0 });
    expect(raw.run.exit_code).toBe(3);
    const { grade } = await runGrade({
      runId: raw.run.id,
      graderPath,
      db: paths.db,
      regrade: false,
    });
    expect(grade.verdict).toBe("pass");
    const checks = JSON.parse(grade.checks_json) as Array<{
      id: string;
      passed: boolean;
      details: string;
    }>;
    expect(checks.map((c) => [c.id, c.passed])).toEqual([
      ["exit-3", true],
      ["status-ok", true],
      ["shape", true],
      ["no-artifact", false],
    ]);
    expect(checks[3]!.details).toBe('no file "out.pdf" was observed after the run');
  });
});
