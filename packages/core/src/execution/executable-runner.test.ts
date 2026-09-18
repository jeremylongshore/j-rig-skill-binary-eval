import { describe, expect, it } from "vitest";
import { ExecutableRunner } from "./executable-runner.js";
import { EvalConfigSchema, EvalTaskSchema, type RunnerRequest } from "./substrate.js";

const task = EvalTaskSchema.parse({
  id: "echo-task",
  version: "1",
  input: { message: "hello" },
});

const request = (script: string, timeout_ms = 2_000): RunnerRequest => ({
  run_id: "raw_123",
  task,
  config: EvalConfigSchema.parse({
    id: "local-echo",
    version: "1",
    model: "fixture-model",
    harness: { command: process.execPath, args: ["-e", script], timeout_ms },
  }),
  model: "fixture-model",
  sample_index: 2,
});

describe("ExecutableRunner", () => {
  it("passes JSON and lineage metadata without inheriting secrets", async () => {
    const script = [
      "let body = '';",
      "process.stdin.on('data', (chunk) => body += chunk);",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(body);",
      "  process.stdout.write(JSON.stringify({ task: request.task.id, run: process.env.J_RIG_RUN_ID, secret: process.env.TEST_SECRET ?? null }));",
      "});",
    ].join("\n");

    const result = await new ExecutableRunner().run(request(script));

    expect(result.status).toBe("completed");
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      task: "echo-task",
      run: "raw_123",
      secret: null,
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.artifacts).toEqual([]);
  });

  it("classifies a non-zero harness exit separately from model output", async () => {
    const result = await new ExecutableRunner().run(
      request(
        'process.stdout.write("model output"); process.stderr.write("harness broke"); process.exit(7);',
      ),
    );

    expect(result.status).toBe("runner_error");
    expect(result.exit_code).toBe(7);
    expect(result.stdout).toBe("model output");
    expect(result.stderr).toBe("harness broke");
  });

  it("terminates a harness that exceeds its configured timeout", async () => {
    const result = await new ExecutableRunner().run(
      request("setTimeout(() => process.exit(0), 1_000);", 25),
    );

    expect(result.status).toBe("timed_out");
    expect(result.error_message).toContain("25 ms");
  });
});
