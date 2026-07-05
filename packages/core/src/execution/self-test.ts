import { spawnSync } from "node:child_process";

import type { Criterion } from "../schemas/criterion.js";
import { SELF_TEST_CRITERION_ID, type SelfTest } from "../schemas/self-test.js";
import type { JudgmentResult } from "../judgment/types.js";

/** Wall-clock ceiling for a self-test run. Deterministic scripts are fast. */
export const DEFAULT_SELF_TEST_TIMEOUT_MS = 120_000;

/** Outcome of running a skill's declared `self_test.command`. */
export interface SelfTestResult {
  /** The command started (false only on spawn failure, e.g. interpreter not found). */
  ran: boolean;
  /** `exit_code === expect_exit`. The whole point: a binary verdict. */
  passed: boolean;
  /** Process exit code; null if killed by signal / timeout / never spawned. */
  exitCode: number | null;
  /** Expected exit code from the spec. */
  expectedExit: number;
  /** True if the run hit the timeout and was killed. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Human message set on spawn failure or timeout (else undefined). */
  error?: string;
}

/**
 * Run a skill's deterministic self-test WITHOUT a shell.
 *
 * The command is whitespace-tokenized (`"python3 scripts/triage.py --self-test"`
 * → argv) — the declared contract is a simple `interpreter script --flag`, and
 * no shell means the command string is not an injection surface. It runs with
 * `cwd` = the skill dir (so relative script paths resolve against the skill) and
 * a SCOPED env that deliberately drops the inherited environment — a self-test
 * can never read an inherited judge API key (ANTHROPIC/OPENAI/DEEPSEEK/…). Living
 * in the eval-orchestration layer (not a `Provider` adapter) keeps this
 * subprocess call clear of the G-2 env-spillover gate that guards adapters.
 *
 * Fail-closed: a spawn failure, a timeout, or the wrong exit code all yield
 * `passed: false` — a self-test that cannot run is not a pass.
 */
export function runSelfTest(
  selfTest: SelfTest,
  skillDir: string,
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): SelfTestResult {
  const start = Date.now();
  const expectedExit = selfTest.expect_exit;
  const argv = selfTest.command.trim().split(/\s+/).filter(Boolean);
  const [exe, ...args] = argv;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SELF_TEST_TIMEOUT_MS;
  const env = opts?.env ?? scopedEnv();

  if (!exe) {
    return {
      ran: false,
      passed: false,
      exitCode: null,
      expectedExit,
      timedOut: false,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - start,
      error: "self_test.command is empty",
    };
  }

  const res = spawnSync(exe, args, {
    cwd: skillDir,
    env,
    timeout: timeoutMs,
    encoding: "utf8",
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  });
  const durationMs = Date.now() - start;
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";

  if (res.error) {
    // A timeout surfaces as ETIMEDOUT and/or a kill signal (SIGTERM); anything
    // else (e.g. ENOENT) means the interpreter was never spawned.
    const timedOut =
      (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT" || res.signal != null;
    return {
      ran: timedOut, // a timeout means it DID start; other errors mean it never ran
      passed: false,
      exitCode: null,
      expectedExit,
      timedOut,
      stdout,
      stderr,
      durationMs,
      error: timedOut
        ? `self-test timed out after ${timeoutMs}ms`
        : `could not run self-test command "${exe}": ${res.error.message}`,
    };
  }

  return {
    ran: true,
    passed: res.status === expectedExit,
    exitCode: res.status,
    expectedExit,
    timedOut: false,
    stdout,
    stderr,
    durationMs,
  };
}

/** Restrict the child env to execution essentials — never inherited secrets. */
function scopedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // PATH is required to resolve `python3`/`node`/…; the rest are harmless locale
  // / temp / Windows-resolution vars. Nothing that could carry an API key.
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "PATHEXT"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** One-line, human-readable summary of a self-test result for the criterion reasoning. */
export function summarizeSelfTest(result: SelfTestResult): string {
  if (result.error) return result.error;
  const exitPart = `exit ${result.exitCode} (expected ${result.expectedExit})`;
  // Surface the script's own tally line if it printed one (e.g. "self-test: 18 passed, 0 failed").
  const tally = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => /self[-\s]?test:/i.test(line) || /\bpassed\b.*\bfailed\b/i.test(line));
  return tally ? `${exitPart} — ${tally.trim()}` : exitPart;
}

/**
 * Convert a self-test result into a deterministic `JudgmentResult` so it scores
 * through the SAME scorecard / rollout machinery as any other criterion (no
 * special-casing downstream).
 */
export function toSelfTestJudgment(result: SelfTestResult): JudgmentResult {
  return {
    criterion_id: SELF_TEST_CRITERION_ID,
    verdict: result.passed ? "yes" : "no",
    confidence: 1,
    reasoning: summarizeSelfTest(result),
    method: "deterministic",
  };
}

/**
 * The synthetic criterion the self-test judgment scores against. Its `blocker`
 * flag comes from the spec (default true) so `computeScoreCard` counts a failed
 * self-test as a blocker failure → `decideRollout` returns `block`.
 */
export function buildSelfTestCriterion(selfTest: SelfTest): Criterion {
  return {
    id: SELF_TEST_CRITERION_ID,
    description:
      "Deterministic self-test: the skill's own script produces the correct verdicts " +
      "(graded on observed script output, not the model's claim).",
    method: "deterministic",
    blocker: selfTest.blocker,
    regression_critical: false,
    baseline_sensitive: false,
    pack_sensitive: false,
  };
}
