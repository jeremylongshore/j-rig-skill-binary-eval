import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { runBatch } from "./batch.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(script: string, targetN = 2) {
  const dir = mkdtempSync(join(tmpdir(), "j-rig-batch-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "task.yaml"),
    stringify({ id: "batch-task", version: "1", input: { question: "2+2" } }),
  );
  writeFileSync(
    join(dir, "config.yaml"),
    stringify({
      id: "batch-config",
      version: "1",
      model: "fixture-model",
      harness: { command: process.execPath, args: ["-e", script] },
    }),
  );
  writeFileSync(
    join(dir, "batch.yaml"),
    stringify({ target_n: targetN, jobs: [{ task: "task.yaml", config: "config.yaml" }] }),
  );
  return { manifestPath: join(dir, "batch.yaml"), db: join(dir, "runs.db") };
}

describe("j-rig batch", () => {
  it("executes balanced samples and resumes the remaining target", async () => {
    const paths = fixture(
      'let body = ""; process.stdin.on("data", c => body += c); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ sample: JSON.parse(body).sample_index })));',
    );

    const first = await runBatch(paths);
    expect(first.initial_plan.jobs.map((job) => job.sample_index)).toEqual([0, 1]);
    expect(first.runs).toHaveLength(2);
    expect(first.runs.every((run) => run.run.status === "completed")).toBe(true);
    expect(first.remaining_plan.jobs).toHaveLength(0);

    const resumed = await runBatch(paths);
    expect(resumed.runs).toHaveLength(0);
    expect(resumed.remaining_plan.jobs).toHaveLength(0);
  });

  it("retains a harness failure and schedules a fresh sample on the next pass", async () => {
    const paths = fixture(
      'let body = ""; process.stdin.on("data", c => body += c); process.stdin.on("end", () => { const sample = JSON.parse(body).sample_index; if (sample === 0) { process.stderr.write("first sample failed"); process.exit(7); } process.stdout.write("recovered"); });',
      1,
    );

    const first = await runBatch(paths);
    expect(first.runs[0]?.run.status).toBe("runner_error");
    expect(first.remaining_plan.jobs.map((job) => job.sample_index)).toEqual([1]);

    const second = await runBatch(paths);
    expect(second.runs[0]?.run.status).toBe("completed");
    expect(second.runs[0]?.run.sample_index).toBe(1);
    expect(second.remaining_plan.jobs).toHaveLength(0);
  });
});
