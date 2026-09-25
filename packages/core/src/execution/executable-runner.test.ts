import { afterEach, describe, expect, it } from "vitest";
import { ExecutableRunner } from "./executable-runner.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  EvalConfigSchema,
  EvalTaskSchema,
  type RunnerRequest,
} from "./substrate.js";

const task = EvalTaskSchema.parse({
  id: "echo-task",
  version: "1",
  input: { message: "hello" },
});

const request = (script: string, timeout_ms = 2_000, max_output_bytes?: number): RunnerRequest => ({
  run_id: "raw_123",
  task,
  config: EvalConfigSchema.parse({
    id: "local-echo",
    version: "1",
    model: "fixture-model",
    harness: {
      command: process.execPath,
      args: ["-e", script],
      timeout_ms,
      ...(max_output_bytes === undefined ? {} : { max_output_bytes }),
    },
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

const isPosix = process.platform !== "win32";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

describe("ExecutableRunner resource bounds", () => {
  const strays: number[] = [];

  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("keeps the config snapshot unchanged when no ceiling is declared (sealed-run reuse)", () => {
    const config = request("process.exit(0)").config;
    expect(JSON.stringify(config)).not.toContain("max_output_bytes");
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(10 * 1024 * 1024);
  });

  it("preserves output that lands exactly on the ceiling", async () => {
    const result = await new ExecutableRunner().run(
      request('process.stdout.write("hello")', 2_000, 5),
    );
    expect(result.status).toBe("completed");
    expect(result.stdout).toBe("hello");
    expect(result.error_message).toBeUndefined();
  });

  it("terminates an unbounded stdout flood and seals a truncated runner_error", async () => {
    const flood = 'const b = "x".repeat(65536); setInterval(() => process.stdout.write(b), 0);';
    const result = await new ExecutableRunner().run(request(flood, 20_000, 1_024));

    expect(result.status).toBe("runner_error");
    expect(Buffer.byteLength(result.stdout)).toBe(1_024);
    expect(result.error_message).toBe(
      "Runner stdout exceeded the 1024-byte output ceiling; harness terminated and output truncated",
    );
    expect(result.duration_ms).toBeLessThan(10_000);
  });

  it("applies the same ceiling to stderr and keeps stdout captured before the overflow", async () => {
    const script =
      'process.stdout.write("partial answer", () => { const b = "e".repeat(65536); setInterval(() => process.stderr.write(b), 0); });';
    const result = await new ExecutableRunner().run(request(script, 20_000, 2_048));

    expect(result.status).toBe("runner_error");
    expect(result.stdout).toBe("partial answer");
    expect(Buffer.byteLength(result.stderr)).toBe(2_048);
    expect(result.error_message).toContain("Runner stderr exceeded the 2048-byte output ceiling");
  });

  it.skipIf(!isPosix)(
    "kills a grandchild that inherited the pipes when the harness times out",
    async () => {
      const script = [
        'const { spawn } = require("node:child_process");',
        'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });',
        'process.stdout.write(String(g.pid) + "\\n");',
        "setTimeout(() => {}, 60000);",
      ].join("\n");
      const result = await new ExecutableRunner().run(request(script, 400));
      const grandchild = Number(result.stdout.trim());
      strays.push(grandchild);

      expect(result.status).toBe("timed_out");
      expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
      expect(await waitForExit(grandchild, 2_000)).toBe(true);
    },
  );

  it.skipIf(!isPosix)(
    "seals the Run in bounded time when an escaped descendant keeps the pipes open",
    async () => {
      const script = [
        'const { spawn } = require("node:child_process");',
        'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit", detached: true });',
        "g.unref();",
        'process.stdout.write(String(g.pid) + "\\n");',
        "setTimeout(() => {}, 60000);",
      ].join("\n");
      const started = Date.now();
      const result = await new ExecutableRunner().run(request(script, 300));
      const elapsed = Date.now() - started;
      const escaped = Number(result.stdout.trim());
      strays.push(escaped);

      expect(result.status).toBe("timed_out");
      expect(result.error_message).toContain("300 ms");
      // 300 timeout + 250 TERM->KILL + 500 KILL->force-finish, with headroom.
      expect(elapsed).toBeLessThan(5_000);
      // The escaped process left the group on purpose; prove the test's own
      // cleanup is what reaps it, not luck.
      expect(isAlive(escaped)).toBe(true);
    },
  );
});
