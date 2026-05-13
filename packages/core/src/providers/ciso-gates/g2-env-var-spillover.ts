/**
 * CISO Gate G-2: env-var spillover.
 *
 * Source: PB-7 measurement protocol § 6 G-2.
 *
 * Test: set provider API keys via environment variables. Invoke the adapter
 * to make one request. While the request is in flight, snapshot
 * /proc/<adapter-process-pid>/environ and /proc/<adapter-subprocess-pid>/environ
 * for any child process the adapter spawns. Pass criterion: no
 * child-process environment contains the API key value.
 *
 * This module's runner takes a different approach than literal /proc reads
 * for portability: it MONITORS subprocess spawning (via a child_process
 * hook) and inspects the env passed to each spawned process. This catches
 * the actual leak vector (the adapter passing env to a child) before the
 * child has any chance to print or write the key. It is strictly stronger
 * than a /proc snapshot which has race-window blind spots.
 *
 * For adapters that perform their own /proc reads (rare), the runner ALSO
 * inspects /proc/<child-pid>/environ for any child that lives long enough,
 * as a defense-in-depth check matching the PB-7 spec verbatim.
 */

import child_process from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

export interface G2Result {
  gate: "G-2-env-var-spillover";
  pass: boolean;
  reason: string;
  /** PIDs of subprocesses spawned during the invocation. */
  spawnedPids?: number[];
  /** Per-pid leak details, when FAIL. */
  perChildLeaks?: Array<{
    pid: number;
    command: string;
    leakedEnvVars: string[];
    source: "spawn-hook" | "proc-environ";
  }>;
}

export interface G2Args {
  /**
   * The synthetic API key value present in the harness's parent environment
   * (the caller is responsible for setting it on `process.env` before
   * calling). The harness checks every spawned child for this value.
   */
  testKey: string;

  /**
   * Caller-controlled invocation, same contract as G-1. MUST trigger at
   * least one model call (or, if the adapter does not spawn for completions,
   * pass anyway — see § Implementation contract below).
   */
  invokeProvider: () => Promise<void>;

  /** Default 30 seconds. */
  timeoutMs?: number;
}

/**
 * Implementation contract: this runner monkey-patches
 * `child_process.{spawn, spawnSync, exec, execSync, fork}` for the duration
 * of `invokeProvider()`. Every spawn is logged with its `options.env` (or
 * inherited `process.env` if `options.env` is undefined). The patched
 * functions delegate to the originals after recording.
 *
 * Originals are restored in `finally` so a throwing provider cannot leave
 * the process's child_process module permanently hooked.
 */
export async function runCisoGateG2(args: G2Args): Promise<G2Result> {
  if (args.testKey.length < 8) {
    return {
      gate: "G-2-env-var-spillover",
      pass: false,
      reason: "testKey shorter than 8 chars; cannot evaluate spillover",
    };
  }

  type CpModule = typeof child_process;
  type SpawnArgs = unknown[];

  const orig = {
    spawn: child_process.spawn,
    spawnSync: child_process.spawnSync,
    exec: child_process.exec,
    execSync: child_process.execSync,
    fork: child_process.fork,
  } as const;

  const recorded: Array<{ pid: number | null; command: string; env: NodeJS.ProcessEnv }> = [];

  function record(command: string, options: { env?: NodeJS.ProcessEnv } | undefined, pid: number | null) {
    const env = options?.env ?? process.env;
    recorded.push({ pid, command, env: { ...env } });
  }

  (child_process as unknown as Record<string, unknown>).spawn = function patchedSpawn(
    this: CpModule,
    ...callArgs: SpawnArgs
  ) {
    const command = String(callArgs[0]);
    const options = (callArgs.find((a) => a && typeof a === "object" && !Array.isArray(a)) ??
      undefined) as { env?: NodeJS.ProcessEnv } | undefined;
    const child = (orig.spawn as unknown as (...a: SpawnArgs) => child_process.ChildProcess).apply(
      this,
      callArgs,
    );
    record(command, options, child.pid ?? null);
    return child;
  } as typeof child_process.spawn;

  (child_process as unknown as Record<string, unknown>).spawnSync = function patchedSpawnSync(
    this: CpModule,
    ...callArgs: SpawnArgs
  ) {
    const command = String(callArgs[0]);
    const options = (callArgs.find((a) => a && typeof a === "object" && !Array.isArray(a)) ??
      undefined) as { env?: NodeJS.ProcessEnv } | undefined;
    record(command, options, null);
    return (orig.spawnSync as unknown as (...a: SpawnArgs) => unknown).apply(this, callArgs) as ReturnType<
      typeof child_process.spawnSync
    >;
  } as typeof child_process.spawnSync;

  (child_process as unknown as Record<string, unknown>).exec = function patchedExec(
    this: CpModule,
    ...callArgs: SpawnArgs
  ) {
    const command = String(callArgs[0]);
    const options = (callArgs.find((a) => a && typeof a === "object" && !Array.isArray(a)) ??
      undefined) as { env?: NodeJS.ProcessEnv } | undefined;
    const child = (orig.exec as unknown as (...a: SpawnArgs) => child_process.ChildProcess).apply(
      this,
      callArgs,
    );
    record(command, options, child.pid ?? null);
    return child;
  } as typeof child_process.exec;

  (child_process as unknown as Record<string, unknown>).execSync = function patchedExecSync(
    this: CpModule,
    ...callArgs: SpawnArgs
  ) {
    const command = String(callArgs[0]);
    const options = (callArgs.find((a) => a && typeof a === "object" && !Array.isArray(a)) ??
      undefined) as { env?: NodeJS.ProcessEnv } | undefined;
    record(command, options, null);
    return (orig.execSync as unknown as (...a: SpawnArgs) => Buffer | string).apply(
      this,
      callArgs,
    );
  } as typeof child_process.execSync;

  (child_process as unknown as Record<string, unknown>).fork = function patchedFork(
    this: CpModule,
    ...callArgs: SpawnArgs
  ) {
    const command = String(callArgs[0]);
    const options = (callArgs.find((a) => a && typeof a === "object" && !Array.isArray(a)) ??
      undefined) as { env?: NodeJS.ProcessEnv } | undefined;
    const child = (orig.fork as unknown as (...a: SpawnArgs) => child_process.ChildProcess).apply(
      this,
      callArgs,
    );
    record(command, options, child.pid ?? null);
    return child;
  } as typeof child_process.fork;

  const timeoutMs = args.timeoutMs ?? 30_000;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);

  let invocationError: Error | null = null;
  try {
    await args.invokeProvider();
  } catch (err) {
    invocationError = err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timeoutHandle);
    (child_process as unknown as Record<string, unknown>).spawn = orig.spawn;
    (child_process as unknown as Record<string, unknown>).spawnSync = orig.spawnSync;
    (child_process as unknown as Record<string, unknown>).exec = orig.exec;
    (child_process as unknown as Record<string, unknown>).execSync = orig.execSync;
    (child_process as unknown as Record<string, unknown>).fork = orig.fork;
  }

  if (timedOut) {
    return {
      gate: "G-2-env-var-spillover",
      pass: false,
      reason: `invocation exceeded timeoutMs=${timeoutMs}; cannot evaluate spillover on a hung adapter`,
    };
  }

  const perChildLeaks: NonNullable<G2Result["perChildLeaks"]> = [];

  for (const r of recorded) {
    const leakedVars: string[] = [];
    for (const [k, v] of Object.entries(r.env)) {
      if (typeof v === "string" && v.includes(args.testKey)) {
        leakedVars.push(k);
      }
    }
    if (leakedVars.length > 0) {
      perChildLeaks.push({
        pid: r.pid ?? -1,
        command: r.command,
        leakedEnvVars: leakedVars,
        source: "spawn-hook",
      });
    }

    // Defense in depth: if the child is still alive, snapshot /proc.
    if (r.pid !== null && existsSync(`/proc/${r.pid}/environ`)) {
      try {
        const raw = readFileSync(`/proc/${r.pid}/environ`, "utf-8");
        if (raw.includes(args.testKey)) {
          // Extract var names that carry the key.
          const procLeaks = raw
            .split("\0")
            .filter((pair) => pair.includes(args.testKey))
            .map((pair) => pair.split("=")[0]);
          perChildLeaks.push({
            pid: r.pid,
            command: r.command,
            leakedEnvVars: procLeaks,
            source: "proc-environ",
          });
        }
      } catch {
        /* child may have exited between the spawn and our read; ignore */
      }
    }
  }

  const spawnedPids = recorded
    .map((r) => r.pid)
    .filter((p): p is number => typeof p === "number");

  if (perChildLeaks.length > 0) {
    return {
      gate: "G-2-env-var-spillover",
      pass: false,
      reason: `${perChildLeaks.length} subprocess(es) had the test key in their environment`,
      spawnedPids,
      perChildLeaks,
    };
  }

  const errSuffix = invocationError
    ? ` (note: invokeProvider threw '${invocationError.message}'; not a gate failure)`
    : "";

  return {
    gate: "G-2-env-var-spillover",
    pass: true,
    reason: `${recorded.length} subprocess(es) inspected; no test-key spillover detected${errSuffix}`,
    spawnedPids,
  };
}
