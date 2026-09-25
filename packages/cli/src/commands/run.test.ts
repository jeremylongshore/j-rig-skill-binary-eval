import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { runGenericEval } from "./run.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "j-rig-generic-run-"));
  tempDirs.push(dir);
  const taskPath = join(dir, "task.yaml");
  const configPath = join(dir, "config.yaml");
  writeFileSync(
    taskPath,
    stringify({
      id: "echo-task",
      version: "1",
      description: "A generic fixture task",
      input: { message: "hello" },
    }),
  );
  writeFileSync(
    configPath,
    stringify({
      id: "fixture-config",
      version: "1",
      model: "fixture-model",
      harness: {
        command: process.execPath,
        args: ["-e", script],
        timeout_ms: 2_000,
      },
    }),
  );
  return { taskPath, configPath, db: join(dir, "runs.db") };
}

describe("j-rig run generic task/config surface", () => {
  it("persists a completed raw run and resumes the same sample read-only", async () => {
    const paths = fixture(
      "let body = ''; process.stdin.on('data', c => body += c); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ received: JSON.parse(body).task.id })));",
    );

    const first = await runGenericEval({ ...paths, sampleIndex: 0 });
    const second = await runGenericEval({ ...paths, sampleIndex: 0 });

    expect(first.run.status).toBe("completed");
    expect(first.run.stdout).toContain('"received":"echo-task"');
    expect(first.reused).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(second.reused).toBe(true);
  });

  it("returns a retained runner error instead of treating it as a model grade", async () => {
    const paths = fixture('process.stderr.write("fixture broke"); process.exit(9);');
    const result = await runGenericEval({ ...paths, sampleIndex: 1 });

    expect(result.run.status).toBe("runner_error");
    expect(result.run.exit_code).toBe(9);
    expect(result.run.stderr).toBe("fixture broke");
  });
});
