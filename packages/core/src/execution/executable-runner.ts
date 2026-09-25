import { spawn, type ChildProcess } from "node:child_process";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  type EvalRunner,
  type RunnerRequest,
  type RunnerResult,
} from "./substrate.js";

const SAFE_INHERITED_ENV = ["PATH", "LANG", "LC_ALL"] as const;

/** Grace between SIGTERM and SIGKILL once a harness exceeds its timeout. */
const TERM_TO_KILL_GRACE_MS = 250;

/**
 * Grace after SIGKILL before the Run is sealed without waiting for `close`.
 * `close` only fires once every holder of the stdio pipes has let go, so a
 * descendant that escaped the process group can otherwise keep a Run pending
 * long after its timeout.
 */
const KILL_TO_FORCE_FINISH_GRACE_MS = 500;

/** Signals on which an interrupted host must not leave harness groups behind. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const IS_POSIX = process.platform !== "win32";

function inheritedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Signal the harness and every descendant still in its process group.
 *
 * On POSIX the harness is spawned as a group leader, so a negative pid reaches
 * grandchildren that a plain `child.kill()` would orphan. Windows has no
 * process groups here; only the immediate child is signalled.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (IS_POSIX && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone (ESRCH) or not ours (EPERM): fall through.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

/** Collects one stream up to a byte ceiling and reports the first overflow. */
class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private closed = false;

  constructor(
    private readonly limit: number,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.closed) return;
    const room = this.limit - this.bytes;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      return;
    }
    if (room > 0) this.chunks.push(chunk.subarray(0, room));
    this.bytes = this.limit;
    this.closed = true;
    this.onOverflow();
  }

  /** Stop retaining data; used once the Run is being torn down. */
  stop(): void {
    this.closed = true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Run an arbitrary harness through a shell-free child process.
 *
 * The harness receives the complete request as JSON on stdin and receives the
 * stable lineage fields through `J_RIG_*` environment variables. Only a small
 * non-secret environment allowlist is inherited; credentials from the parent
 * process are never forwarded implicitly.
 *
 * Resource bounds (these are host-protection limits, NOT a sandbox — the
 * harness still runs as trusted local code with the caller's privileges):
 *  - stdout and stderr are each capped at `harness.max_output_bytes`
 *    (default `DEFAULT_MAX_OUTPUT_BYTES`). Overflow terminates the harness and
 *    seals a `runner_error` Run that retains the bytes captured up to the cap.
 *  - On timeout or overflow the whole process group is signalled, so
 *    descendants are cleaned up rather than orphaned (POSIX only).
 *  - Completion is bounded: if an escaped descendant keeps the pipes open, the
 *    Run is sealed shortly after SIGKILL instead of waiting on `close`.
 */
export class ExecutableRunner implements EvalRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    const harness = request.config.harness;
    const outputLimit = harness.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

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
      let overflowStream: "stdout" | "stderr" | undefined;
      let processError: string | undefined;
      let settled = false;
      let exited: { code: number | null; signal: string | null } | undefined;
      let killHandle: NodeJS.Timeout | undefined;
      let forceHandle: NodeJS.Timeout | undefined;

      const child = spawn(harness.command, harness.args, {
        cwd: harness.cwd,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        // Group leader on POSIX so timeout/overflow cleanup reaches descendants.
        detached: IS_POSIX,
      });

      // A detached group no longer receives the terminal's Ctrl-C, so forward
      // host termination to it and then let the host's own handling proceed.
      const signalHandlers = new Map<NodeJS.Signals, () => void>();
      const onHostExit = (): void => killTree(child, "SIGKILL");
      const detachHostHandlers = (): void => {
        process.removeListener("exit", onHostExit);
        for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
        signalHandlers.clear();
      };
      process.once("exit", onHostExit);
      for (const signal of FORWARDED_SIGNALS) {
        const handler = (): void => {
          killTree(child, "SIGKILL");
          detachHostHandlers();
          if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
      }

      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);
        if (forceHandle) clearTimeout(forceHandle);
        detachHostHandlers();
        stdout.stop();
        stderr.stop();

        const completedAtMs = Date.now();
        const completedAt = new Date(completedAtMs).toISOString();
        const status = timedOut
          ? "timed_out"
          : overflowStream || processError || exitCode !== 0
            ? "runner_error"
            : "completed";
        const errorMessage = timedOut
          ? `Runner timed out after ${harness.timeout_ms} ms`
          : overflowStream
            ? `Runner ${overflowStream} exceeded the ${outputLimit}-byte output ceiling; harness terminated and output truncated`
            : processError;

        resolve({
          status,
          stdout: stdout.text(),
          stderr: stderr.text(),
          exit_code: exitCode,
          signal,
          started_at: startedAt,
          completed_at: completedAt,
          duration_ms: completedAtMs - startedAtMs,
          error_message: errorMessage,
          artifacts: [],
        });
      };

      /** Seal the Run even if an escaped descendant never releases the pipes. */
      const armForceFinish = (): void => {
        forceHandle ??= setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(exited?.code ?? null, exited?.signal ?? "SIGKILL");
        }, KILL_TO_FORCE_FINISH_GRACE_MS);
      };

      const onOverflow = (stream: "stdout" | "stderr") => (): void => {
        if (timedOut || overflowStream) return;
        overflowStream = stream;
        // A harness flooding output gets no graceful window.
        killTree(child, "SIGKILL");
        armForceFinish();
      };
      const stdout = new BoundedCapture(outputLimit, onOverflow("stdout"));
      const stderr = new BoundedCapture(outputLimit, onOverflow("stderr"));

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        processError = error.message;
      });
      child.stdin.on("error", (error) => {
        processError ??= error.message;
      });
      child.on("exit", (code, signal) => {
        exited = { code, signal };
      });
      child.on("close", finish);

      const timeoutHandle = setTimeout(() => {
        if (overflowStream) return;
        timedOut = true;
        killTree(child, "SIGTERM");
        killHandle = setTimeout(() => {
          killTree(child, "SIGKILL");
          armForceFinish();
        }, TERM_TO_KILL_GRACE_MS);
      }, harness.timeout_ms);

      child.stdin.end(JSON.stringify(request));
    });
  }
}
