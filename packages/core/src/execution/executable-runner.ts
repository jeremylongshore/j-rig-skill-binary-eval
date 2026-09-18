import { spawn } from "node:child_process";
import type { EvalRunner, RunnerRequest, RunnerResult } from "./substrate.js";

const SAFE_INHERITED_ENV = ["PATH", "LANG", "LC_ALL"] as const;

function inheritedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Run an arbitrary harness through a shell-free child process.
 *
 * The harness receives the complete request as JSON on stdin and receives the
 * stable lineage fields through `J_RIG_*` environment variables. Only a small
 * non-secret environment allowlist is inherited; credentials from the parent
 * process are never forwarded implicitly.
 */
export class ExecutableRunner implements EvalRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    const harness = request.config.harness;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const env: Record<string, string> = {
      ...inheritedEnvironment(),
      ...harness.env,
      J_RIG_RUN_ID: request.run_id,
      J_RIG_TASK_ID: request.task.id,
      J_RIG_TASK_VERSION: request.task.version,
      J_RIG_CONFIG_ID: request.config.id,
      J_RIG_CONFIG_VERSION: request.config.version,
      J_RIG_MODEL: request.model,
      J_RIG_SAMPLE_INDEX: String(request.sample_index),
    };

    return await new Promise<RunnerResult>((resolve) => {
      let timedOut = false;
      let processError: string | undefined;
      let settled = false;
      let killHandle: NodeJS.Timeout | undefined;

      const child = spawn(harness.command, harness.args, {
        cwd: harness.cwd,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);

        const completedAtMs = Date.now();
        const completedAt = new Date(completedAtMs).toISOString();
        const status = timedOut
          ? "timed_out"
          : processError || exitCode !== 0
            ? "runner_error"
            : "completed";

        resolve({
          status,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exit_code: exitCode,
          signal,
          started_at: startedAt,
          completed_at: completedAt,
          duration_ms: completedAtMs - startedAtMs,
          error_message: timedOut
            ? `Runner timed out after ${harness.timeout_ms} ms`
            : processError,
          artifacts: [],
        });
      };

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        processError = error.message;
      });
      child.stdin.on("error", (error) => {
        processError ??= error.message;
      });
      child.on("close", finish);

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killHandle = setTimeout(() => child.kill("SIGKILL"), 250);
      }, harness.timeout_ms);

      child.stdin.end(JSON.stringify(request));
    });
  }
}
