/**
 * `claude-code` execution provider — runs the skill under test inside real
 * Claude Code (`claude -p --output-format stream-json`) and records what it
 * DID: every tool call in order, and every file it produced, with sha256.
 *
 * Every other execution provider sends one chat completion with SKILL.md as
 * the system prompt, so it can only report text (`tool_calls: 0`,
 * `artifacts: []`) and a file-producing skill cannot be graded. This one
 * gives each test case a fresh workspace:
 *
 *   <tmp>/j-rig-cc-XXXX/
 *     ws/                          cwd of the agent
 *       .claude/skills/<name>/     a COPY of the skill dir (never a symlink;
 *                                  omitted for the naked baseline)
 *       <fixtures>                 --workspace-fixtures dir + the case's
 *                                  context_hints.workspace_files
 *     home/                        HOME and CLAUDE_CONFIG_DIR of the agent
 *       .claude/.credentials.json  the subscription ACCESS token only
 *
 * Isolation, honestly stated: this is workspace isolation, not an OS
 * sandbox. The agent runs as the invoking user, so a command can still reach
 * absolute paths. What it does NOT get: the user's settings, CLAUDE.md,
 * skills, plugins, hooks, MCP servers or session history (HOME points at the
 * empty sandbox home, `--setting-sources project`, `--strict-mcp-config`); any
 * Anthropic API key or other environment variable outside a short allowlist;
 * or the OAuth refresh token (only the short-lived access token is copied, so
 * the run can never rotate the user's login).
 *
 * Billing rule (estate provider policy): this provider authenticates with the
 * local Claude subscription ONLY. It refuses to start under CI, strips every
 * ANTHROPIC_* variable, and aborts the run if Claude Code reports any
 * `apiKeySource` other than `none`. CI exercises the parser and the
 * trajectory checks against recorded transcripts
 * (`src/providers/fixtures/claude-code/`), never a live run.
 *
 * Budget: each case is bounded by wall-clock (`timeoutMs`) and assistant
 * turns (`maxTurns`), both enforced here by killing the process group, plus
 * Claude Code's own `--max-budget-usd` (API-equivalent dollars). A case that
 * exhausts a budget is NOT completed: it carries an error, is never judged,
 * and the run is signed `error` (000-docs/037), because grading a truncated
 * trajectory would let `tool_not_called` pass on a run that was cut short.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import {
  ProviderError,
  TRAJECTORY_SCHEMA,
  type ArtifactRecord,
  type ExecutionContext,
  type ExecutionMeta,
  type ExecutionOutput,
  type ExecutionProvider,
  type TokenUsage,
  type Trajectory,
  type TrajectoryFile,
  type TrajectoryStop,
} from "@j-rig/core";
import { ClaudeStreamParser, type ParsedClaudeStream } from "./claude-code-stream.js";

export const CLAUDE_CODE_PROVIDER_NAME = "claude-code";

/** Defaults are runtime-applied, never schema defaults (see CLAUDE.md harness rule). */
export const CLAUDE_CODE_DEFAULTS = {
  timeoutMs: 300_000,
  maxTurns: 25,
  maxBudgetUsd: 1,
  tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill"],
} as const;

/** Produced text files up to this size are captured with their content. */
export const MAX_TEXT_ARTIFACT_BYTES = 256 * 1024;

/** Environment variables the agent process may inherit (everything else is dropped). */
const ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
];

/** Directory names never copied from the skill dir into the workspace. */
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv"]);

const KILL_GRACE_MS = 2_000;

export interface ClaudeCodeProviderOptions {
  /** Absolute path of the skill directory under test (holds SKILL.md). */
  skillDir: string;
  /** Skill name; the copy is installed at `.claude/skills/<skillName>/`. */
  skillName: string;
  /** Model passed to `claude --model` (alias or full id). */
  model: string;
  /** Directory copied into every case workspace before the run. */
  fixturesDir?: string;
  timeoutMs?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Tool list for both `--tools` and `--allowedTools`. */
  tools?: readonly string[];
  /** Keep each case's temp dir (debugging); the path is reported on stderr. */
  keepWorkspaces?: boolean;
  /** Called once per case with the token usage Claude Code reported (cost meter hook). */
  onUsage?: (model: string, usage: TokenUsage) => void;
  // ── Seams (tests) ──
  /** Executable to run (default `claude` on PATH). */
  claudeBin?: string;
  /** Environment the guard and allowlist read from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /**
   * Subscription credentials file (default `$CLAUDE_CONFIG_DIR/.credentials.json`
   * or `~/.claude/.credentials.json`).
   */
  credentialsPath?: string;
  /** Clock for the access-token expiry guard. */
  now?: () => number;
}

/** Thrown before any spawn when the run would violate the billing or sandbox rules. */
export class ClaudeCodeRefusedError extends Error {
  constructor(message: string) {
    super(`claude-code execution refused: ${message}`);
    this.name = "ClaudeCodeRefusedError";
  }
}

/** True for any truthy CI marker (GitHub Actions sets both). */
export function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  const truthy = (v: string | undefined) =>
    v !== undefined && v !== "" && v !== "0" && v !== "false";
  return truthy(env.CI) || truthy(env.GITHUB_ACTIONS);
}

/**
 * Validate a workspace-relative fixture path: relative, normalized, inside
 * the workspace, and not under `.claude/` (the installed skill lives there).
 */
export function safeWorkspacePath(p: string): string {
  if (!p || isAbsolute(p) || p.includes("\0")) {
    throw new Error(`workspace file path must be relative: ${JSON.stringify(p)}`);
  }
  const n = normalize(p);
  if (
    n === ".." ||
    n.startsWith(`..${sep}`) ||
    n === "." ||
    n.startsWith(`.claude${sep}`) ||
    n === ".claude"
  ) {
    throw new Error(
      `workspace file path escapes the workspace or targets .claude/: ${JSON.stringify(p)}`,
    );
  }
  return n;
}

/** Copy a tree without following or copying symlinks (a symlink could write through to the source). */
function copyTree(src: string, dest: string, skip: Set<string> = new Set()): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ClaudeCodeRefusedError(`symlink in a copied tree is not allowed: ${from}`);
    }
    if (entry.isDirectory()) copyTree(from, to, skip);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

interface ManifestEntry {
  sha256: string;
  size: number;
  bytes: Buffer;
}

/** sha256 manifest of every regular file under `root`, excluding top-level `.claude/`. */
function snapshot(root: string): Map<string, ManifestEntry> {
  const out = new Map<string, ManifestEntry>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (rel === ".claude") continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const bytes = readFileSync(abs);
        out.set(rel, {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          bytes,
        });
      } else if (entry.isSymbolicLink()) {
        // Record the link itself (its target string), never the bytes it points at.
        const target = Buffer.from(`symlink:${readlinkSync(abs)}`);
        out.set(rel, {
          sha256: createHash("sha256").update(target).digest("hex"),
          size: 0,
          bytes: Buffer.alloc(0),
        });
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Diff two snapshots into the trajectory file manifest (sorted by path). */
export function diffManifests(
  before: Map<string, { sha256: string }>,
  after: Map<string, { sha256: string; size: number }>,
): TrajectoryFile[] {
  const files: TrajectoryFile[] = [];
  for (const [path, a] of after) {
    const b = before.get(path);
    files.push({
      path,
      sha256: a.sha256,
      size_bytes: a.size,
      change: !b ? "created" : b.sha256 === a.sha256 ? "unchanged" : "modified",
    });
  }
  for (const path of before.keys()) {
    if (!after.has(path)) files.push({ path, sha256: null, size_bytes: 0, change: "deleted" });
  }
  return files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Artifacts for every created/modified file: text inline (bounded), else a sha reference. */
export function producedArtifacts(
  files: TrajectoryFile[],
  after: Map<string, ManifestEntry>,
): ArtifactRecord[] {
  const out: ArtifactRecord[] = [];
  for (const f of files) {
    if (f.change !== "created" && f.change !== "modified") continue;
    const entry = after.get(f.path);
    if (!entry) continue;
    if (entry.size <= MAX_TEXT_ARTIFACT_BYTES && isText(entry.bytes)) {
      out.push({
        filename: f.path,
        content: entry.bytes.toString("utf8"),
        type: "text",
        size_bytes: entry.size,
      });
    } else {
      out.push({
        filename: f.path,
        content: `sha256:${entry.sha256}`,
        type: "binary_ref",
        size_bytes: entry.size,
      });
    }
  }
  return out;
}

/**
 * Write the sandbox credentials: the subscription access token WITHOUT the
 * refresh token, and only when it outlives the case budget. Returns the
 * written path.
 */
export function writeSandboxCredentials(
  sourcePath: string,
  sandboxConfigDir: string,
  minValidMs: number,
  now: number,
): string {
  if (!existsSync(sourcePath)) {
    throw new ClaudeCodeRefusedError(
      `no Claude subscription credentials at ${sourcePath}; log in with \`claude\` first ` +
        `(API keys are never used by this provider)`,
    );
  }
  let oauth: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    const o = parsed.claudeAiOauth;
    if (o && typeof o === "object") oauth = o as Record<string, unknown>;
  } catch {
    throw new ClaudeCodeRefusedError(
      `subscription credentials at ${sourcePath} are not valid JSON`,
    );
  }
  if (!oauth || typeof oauth.accessToken !== "string") {
    throw new ClaudeCodeRefusedError(`no claudeAiOauth access token in ${sourcePath}`);
  }
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
  if (expiresAt - now < minValidMs) {
    throw new ClaudeCodeRefusedError(
      `the subscription access token expires in ${Math.max(0, Math.round((expiresAt - now) / 1000))}s, ` +
        `less than the case budget; run any \`claude\` command to refresh it, then retry`,
    );
  }
  // Copy everything except the refresh token: without it the sandbox can
  // never rotate (and so never invalidate) the user's real login.
  const { refreshToken: _drop, ...accessOnly } = oauth;
  void _drop;
  mkdirSync(sandboxConfigDir, { recursive: true, mode: 0o700 });
  const dest = join(sandboxConfigDir, ".credentials.json");
  writeFileSync(dest, JSON.stringify({ claudeAiOauth: accessOnly }), { mode: 0o600 });
  chmodSync(dest, 0o600);
  return dest;
}

function defaultCredentialsPath(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  return join(configDir, ".credentials.json");
}

/** Build the agent's environment from the allowlist plus the sandbox home. */
export function sandboxEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) if (env[k] !== undefined) out[k] = env[k];
  out.HOME = home;
  out.CLAUDE_CONFIG_DIR = join(home, ".claude");
  out.DISABLE_AUTOUPDATER = "1";
  out.DISABLE_TELEMETRY = "1";
  out.DISABLE_ERROR_REPORTING = "1";
  return out;
}

export function buildClaudeArgs(
  prompt: string,
  model: string,
  tools: readonly string[],
  maxBudgetUsd: number,
): string[] {
  return [
    "-p",
    prompt,
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--tools",
    ...tools,
    "--allowedTools",
    ...tools,
    "--max-budget-usd",
    String(maxBudgetUsd),
  ];
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

interface RunOutcome {
  parsed: ParsedClaudeStream;
  exitCode: number | null;
  stop: TrajectoryStop;
  stderrTail: string;
  refusal?: string;
}

export class ClaudeCodeExecutionProvider implements ExecutionProvider {
  readonly name = CLAUDE_CODE_PROVIDER_NAME;
  readonly #o: ClaudeCodeProviderOptions;

  constructor(options: ClaudeCodeProviderOptions) {
    const env = options.env ?? process.env;
    if (isCiEnvironment(env)) {
      throw new ClaudeCodeRefusedError(
        "CI detected (CI/GITHUB_ACTIONS). Live Claude Code runs are local-subscription only; " +
          "CI must exercise the recorded-transcript tests instead",
      );
    }
    this.#o = options;
  }

  async execute(
    prompt: string,
    context: ExecutionContext,
    options?: { timeout_ms?: number; model?: string; temperature?: number },
  ): Promise<ExecutionOutput & { meta: ExecutionMeta }> {
    const o = this.#o;
    const env = o.env ?? process.env;
    const timeoutMs = Math.min(
      o.timeoutMs ?? CLAUDE_CODE_DEFAULTS.timeoutMs,
      options?.timeout_ms ?? Number.POSITIVE_INFINITY,
    );
    const maxTurns = o.maxTurns ?? CLAUDE_CODE_DEFAULTS.maxTurns;
    const tools = o.tools ?? CLAUDE_CODE_DEFAULTS.tools;
    const model = o.model;
    const now = o.now ?? Date.now;

    const root = mkdtempSync(join(tmpdir(), "j-rig-cc-"));
    const ws = join(root, "ws");
    const home = join(root, "home");
    const started = new Date();
    try {
      mkdirSync(ws, { recursive: true });
      if (o.fixturesDir) copyTree(o.fixturesDir, ws, new Set([".claude"]));
      const files = context.context_hints?.["workspace_files"];
      if (files !== undefined) {
        if (typeof files !== "object" || files === null || Array.isArray(files)) {
          throw new Error("context_hints.workspace_files must be a map of relative path to text");
        }
        for (const [p, content] of Object.entries(files as Record<string, unknown>)) {
          if (typeof content !== "string") {
            throw new Error(`context_hints.workspace_files["${p}"] must be a string`);
          }
          const dest = join(ws, safeWorkspacePath(p));
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, content);
        }
      }
      // The naked baseline passes an empty body: run the same agent WITHOUT the skill.
      if (context.skill_body.trim() !== "") {
        copyTree(o.skillDir, join(ws, ".claude", "skills", o.skillName), SKIP_DIRS);
      }
      const before = snapshot(ws);

      writeSandboxCredentials(
        o.credentialsPath ?? defaultCredentialsPath(env),
        join(home, ".claude"),
        timeoutMs + 60_000,
        now(),
      );

      const run = await this.#run(
        buildClaudeArgs(prompt, model, tools, o.maxBudgetUsd ?? CLAUDE_CODE_DEFAULTS.maxBudgetUsd),
        ws,
        sandboxEnv(env, home),
        timeoutMs,
        maxTurns,
      );
      if (run.refusal) throw new ClaudeCodeRefusedError(run.refusal);

      const after = snapshot(ws);
      const manifest = diffManifests(before, after);
      const completed = new Date();
      const { parsed } = run;
      const r = parsed.result;

      if (!r && run.stop === "no_result") {
        // The CLI died without a result event: an infrastructure failure, not skill behavior.
        throw new ProviderError({
          category: /auth|login|credential|unauthori[sz]ed|401/i.test(run.stderrTail)
            ? "authentication"
            : "unknown",
          providerName: CLAUDE_CODE_PROVIDER_NAME,
          message: `claude exited ${run.exitCode} without a result event: ${run.stderrTail.slice(-500)}`,
        });
      }

      const trajectory: Trajectory = {
        schema: TRAJECTORY_SCHEMA,
        source: CLAUDE_CODE_PROVIDER_NAME,
        steps: parsed.steps,
        files: manifest,
        turns: parsed.turns,
        stop: run.stop,
      };
      const usage = r?.usage;
      const inputTokens = usage
        ? usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
        : undefined;
      if (usage && o.onUsage) {
        o.onUsage(`${CLAUDE_CODE_PROVIDER_NAME}/${parsed.init?.model ?? model}`, {
          inputTokens: inputTokens ?? 0,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cacheReadInputTokens,
        });
      }

      const error =
        run.stop === "max_turns"
          ? `claude-code turn budget exhausted (${maxTurns} turns); the trajectory is truncated and is not graded`
          : run.stop === "timeout"
            ? `claude-code wall-clock budget exhausted (${timeoutMs} ms); the trajectory is truncated and is not graded`
            : run.stop === "budget"
              ? `claude-code --max-budget-usd exhausted; the trajectory is truncated and is not graded`
              : run.stop === "error"
                ? `claude-code run ended in error (${r?.subtype ?? "unknown"})`
                : undefined;

      if (o.keepWorkspaces) process.stderr.write(`  [claude-code] kept workspace ${root}\n`);
      return {
        text: r?.text ?? parsed.lastText,
        artifacts: producedArtifacts(manifest, after),
        tool_calls: parsed.steps.length,
        trajectory,
        ...(error ? { error } : {}),
        meta: {
          started_at: started.toISOString(),
          completed_at: completed.toISOString(),
          duration_ms: completed.getTime() - started.getTime(),
          ...(usage
            ? {
                input_tokens: inputTokens,
                output_tokens: usage.outputTokens,
                total_tokens: (inputTokens ?? 0) + usage.outputTokens,
              }
            : {}),
          ...(r?.totalCostUsd !== undefined ? { estimated_cost_usd: r.totalCostUsd } : {}),
          timed_out: run.stop === "timeout",
        },
      };
    } finally {
      if (!o.keepWorkspaces) rmSync(root, { recursive: true, force: true });
    }
  }

  #run(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    maxTurns: number,
  ): Promise<RunOutcome> {
    return new Promise((resolve, reject) => {
      const parser = new ClaudeStreamParser(cwd);
      let stderr = "";
      let stop: TrajectoryStop | null = null;
      let refusal: string | undefined;
      let child: ChildProcess;
      try {
        child = spawn(this.#o.claudeBin ?? "claude", args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (err) {
        reject(err);
        return;
      }
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = (why: TrajectoryStop): void => {
        if (stop !== null) return;
        stop = why;
        killGroup(child, "SIGTERM");
        killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      };
      const wall = setTimeout(() => terminate("timeout"), timeoutMs);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        parser.push(chunk);
        const init = parser.init;
        if (init && init.apiKeySource !== undefined && init.apiKeySource !== "none" && !refusal) {
          refusal =
            `Claude Code reported apiKeySource "${init.apiKeySource}"; this provider runs on the ` +
            `local subscription only and never on an API key`;
          terminate("error");
        }
        if (parser.turns > maxTurns) terminate("max_turns");
      });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on("error", (err) => {
        clearTimeout(wall);
        if (killTimer) clearTimeout(killTimer);
        // Usually a failed spawn (no pid, so a no-op); otherwise never leave a live group behind.
        killGroup(child, "SIGKILL");
        reject(
          new ProviderError({
            category: "unknown",
            providerName: CLAUDE_CODE_PROVIDER_NAME,
            message: `could not start claude: ${err.message}`,
            originalError: err,
          }),
        );
      });
      child.on("close", (code) => {
        clearTimeout(wall);
        if (killTimer) clearTimeout(killTimer);
        const parsed = parser.finish();
        let final: TrajectoryStop;
        if (stop !== null) final = stop;
        else if (!parsed.result) final = "no_result";
        else if (parsed.result.subtype === "error_max_turns") final = "max_turns";
        else if (parsed.result.subtype === "error_max_budget_usd") final = "budget";
        else if (parsed.result.isError) final = "error";
        else final = "completed";
        resolve({
          parsed,
          exitCode: code,
          stop: final,
          stderrTail: stderr,
          ...(refusal ? { refusal } : {}),
        });
      });
    });
  }
}
