import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CriterionSchema, ProviderError, judgeCriteria, type ExecutionContext } from "@j-rig/core";
import {
  ClaudeCodeExecutionProvider,
  ClaudeCodeRefusedError,
  buildClaudeArgs,
  diffManifests,
  isCiEnvironment,
  safeWorkspacePath,
  sandboxEnv,
  type ClaudeCodeProviderOptions,
} from "./claude-code.js";
import { resolveClaudeCodeSettings } from "../commands/eval.js";

// No live Claude Code here, ever: `claudeBin` points at a test double that
// replays transcripts recorded locally on the subscription.
const FIXTURES = join(import.meta.dirname, "__fixtures__", "claude-code");
const FAKE = join(FIXTURES, "fake-claude.mjs");
const NOW = 1_800_000_000_000;
const SHA = "4480c3f1dd1164a44521007b732fee306b2e3ce5f3c1cb64e2825db7b5d1e231";

let scratch: string;
let skillDir: string;
let credentialsPath: string;

beforeAll(() => {
  chmodSync(FAKE, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "j-rig-cc-test-"));
  skillDir = join(scratch, "skill");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  mkdirSync(join(skillDir, "node_modules"), { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: receipt-writer\ndescription: d\n---\nbody\n",
  );
  writeFileSync(join(skillDir, "scripts", "x.sh"), "echo x\n");
  writeFileSync(join(skillDir, "node_modules", "big.js"), "never copied\n");
  credentialsPath = join(scratch, "credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: NOW + 3_600_000,
        scopes: [],
      },
      mcpOAuth: { other: { accessToken: "never copied" } },
    }),
  );
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function provider(over: Partial<ClaudeCodeProviderOptions> = {}): ClaudeCodeExecutionProvider {
  return new ClaudeCodeExecutionProvider({
    skillDir,
    skillName: "receipt-writer",
    model: "haiku",
    claudeBin: FAKE,
    credentialsPath,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-ant-should-never-pass", SECRET: "x" },
    now: () => NOW,
    ...over,
  });
}

const ctx = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
  skill_body: "body",
  ...over,
});

function jRigTempDirs(): string[] {
  return readdirSync(tmpdir()).filter(
    (d) => d.startsWith("j-rig-cc-") && !d.startsWith("j-rig-cc-test-"),
  );
}

describe("ClaudeCodeExecutionProvider — replayed write-receipt run", () => {
  it("records the trajectory, produced files with sha256, artifacts, usage and cost", async () => {
    const usage: Array<[string, unknown]> = [];
    const before = new Set(jRigTempDirs());
    const out = await provider({ onUsage: (m, u) => usage.push([m, u]) }).execute(
      "FIXTURE write-receipt",
      ctx({ context_hints: { workspace_files: { "inputs/brief.txt": "brief" } } }),
    );

    expect(out.error).toBeUndefined();
    expect(out.tool_calls).toBe(3);
    expect(out.text).toContain("report.md.sha256");
    expect(out.trajectory?.stop).toBe("completed");
    expect(out.trajectory?.turns).toBe(4);
    expect(out.trajectory?.steps.map((s) => [s.tool, s.input_summary])).toEqual([
      ["Skill", "receipt-writer"],
      ["Write", "report.md"],
      ["Bash", "sha256sum report.md > report.md.sha256"],
    ]);
    expect(out.trajectory?.files).toEqual([
      { path: "inputs/brief.txt", sha256: expect.any(String), size_bytes: 5, change: "unchanged" },
      { path: "report.md", sha256: SHA, size_bytes: 11, change: "created" },
      { path: "report.md.sha256", sha256: expect.any(String), size_bytes: 76, change: "created" },
    ]);
    expect(out.artifacts.map((a) => [a.filename, a.type])).toEqual([
      ["report.md", "text"],
      ["report.md.sha256", "text"],
    ]);
    expect(out.meta).toMatchObject({
      input_tokens: 8 + 11316 + 32766,
      output_tokens: 321,
      estimated_cost_usd: 0.00275216,
      timed_out: false,
    });
    // The fake's init reports the real model, so the meter is keyed on it.
    expect(usage).toEqual([
      [
        "claude-code/claude-haiku-5-5",
        { inputTokens: 44090, outputTokens: 321, cachedInputTokens: 32766 },
      ],
    ]);
    // Per-case temp dir is removed.
    expect(jRigTempDirs().filter((d) => !before.has(d))).toEqual([]);
  });

  it("feeds the trajectory checks end to end", async () => {
    const out = await provider().execute("FIXTURE write-receipt", ctx());
    const outcome = {
      test_case_id: "t",
      prompt: "p",
      output: out,
      meta: out.meta,
      status: "completed" as const,
    };
    const c = (id: string, check: string, params: Record<string, unknown>) =>
      CriterionSchema.parse({
        id,
        description: id,
        method: "deterministic",
        deterministic_check: check,
        deterministic_check_params: params,
      });
    const results = await judgeCriteria(
      [
        c("uses-skill", "tool_called", { tool: "Skill", input_contains: "receipt-writer" }),
        c("no-edit", "tool_not_called", { tool: "Edit" }),
        c("write-then-sum", "order_before", {
          first: { tool: "Write" },
          then: { tool: "Bash", input_contains: "sha256sum" },
        }),
        c("report", "file_exists", { path: "report.md", produced: true }),
        c("receipt", "file_matches_sha_in", { path: "report.md", in: "{path}.sha256" }),
        c("sum-then-write", "order_before", {
          first: { tool: "Bash" },
          then: { tool: "Write" },
        }),
      ],
      outcome,
      { judge: () => Promise.reject(new Error("unused")) } as never,
    );
    expect(Object.fromEntries(results.map((r) => [r.criterion_id, r.verdict]))).toEqual({
      "uses-skill": "yes",
      "no-edit": "yes",
      "write-then-sum": "yes",
      report: "yes",
      receipt: "yes",
      "sum-then-write": "no",
    });
  });
});

describe("ClaudeCodeExecutionProvider — sandbox", () => {
  it("gives the agent an allowlisted env, a sandbox HOME and an access-only credential", async () => {
    const out = await provider().execute("ENV", ctx());
    const env = JSON.parse(out.artifacts.find((a) => a.filename === "env.json")!.content) as {
      keys: string[];
      home: string;
      configDir: string;
      credentialKeys: string[];
      skillInstalled: boolean;
    };
    expect(env.keys).not.toContain("ANTHROPIC_API_KEY");
    expect(env.keys).not.toContain("SECRET");
    expect(env.keys).toEqual(
      expect.arrayContaining(["CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HOME", "PATH"]),
    );
    expect(env.home).toMatch(/j-rig-cc-[^/]+\/home$/);
    expect(env.configDir).toBe(`${env.home}/.claude`);
    expect(env.credentialKeys).toEqual(["accessToken", "expiresAt", "scopes"]);
    expect(env.skillInstalled).toBe(true);
    // The skill copy and sandbox home never appear in the produced-file manifest.
    expect(out.trajectory?.files.map((f) => f.path)).toEqual(["env.json", "notes.txt"]);
    expect(out.trajectory?.steps.find((s) => s.is_error)?.input_summary).toBe("missing.txt");
  });

  it("runs the naked baseline without installing the skill", async () => {
    const out = await provider().execute("ENV", ctx({ skill_body: "  " }));
    const env = JSON.parse(out.artifacts.find((a) => a.filename === "env.json")!.content);
    expect(env.skillInstalled).toBe(false);
  });

  it("copies --workspace-fixtures, refuses symlinks in them, and validates workspace_files paths", async () => {
    const fixtures = join(scratch, "fixtures");
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(join(fixtures, "notes.txt"), "alpha line\nbeta line\n");
    const out = await provider({ fixturesDir: fixtures }).execute("FIXTURE read-missing", ctx());
    expect(out.trajectory?.files).toEqual([
      { path: "notes.txt", sha256: expect.any(String), size_bytes: 21, change: "unchanged" },
    ]);
    expect(out.artifacts).toEqual([]);

    const linked = join(scratch, "linked");
    mkdirSync(linked, { recursive: true });
    symlinkSync("/etc/hostname", join(linked, "escape"));
    await expect(
      provider({ fixturesDir: linked }).execute("FIXTURE read-missing", ctx()),
    ).rejects.toThrow(ClaudeCodeRefusedError);
    await expect(
      provider().execute(
        "FIXTURE read-missing",
        ctx({ context_hints: { workspace_files: { "../x": "y" } } }),
      ),
    ).rejects.toThrow(/escapes the workspace/);
    expect(() => safeWorkspacePath("/abs")).toThrow(/must be relative/);
    expect(() => safeWorkspacePath(".claude/skills/x")).toThrow(/targets \.claude/);
    expect(safeWorkspacePath("a/./b.md")).toBe("a/b.md");
  });
});

describe("ClaudeCodeExecutionProvider — billing rule and budgets", () => {
  it("refuses to construct under CI", () => {
    expect(() => provider({ env: { CI: "true" } })).toThrow(/local-subscription only/);
    expect(() => provider({ env: { GITHUB_ACTIONS: "true" } })).toThrow(ClaudeCodeRefusedError);
    expect(isCiEnvironment({ CI: "false" })).toBe(false);
    expect(isCiEnvironment({ CI: "0" })).toBe(false);
    expect(isCiEnvironment({})).toBe(false);
  });

  it("aborts a run whose init reports an API key source", async () => {
    await expect(provider().execute("APIKEY", ctx())).rejects.toThrow(/subscription only/);
  });

  it("refuses when the access token would expire inside the case budget, or is absent", async () => {
    await expect(provider({ now: () => NOW + 3_590_000 }).execute("HANG", ctx())).rejects.toThrow(
      /expires in 10s/,
    );
    await expect(
      provider({ credentialsPath: join(scratch, "nope.json") }).execute("HANG", ctx()),
    ).rejects.toThrow(/no Claude subscription credentials/);
  });

  it("kills the process group at the wall-clock budget and marks the case not completed", async () => {
    const out = await provider({ timeoutMs: 300 }).execute("HANG", ctx());
    expect(out.meta.timed_out).toBe(true);
    expect(out.trajectory?.stop).toBe("timeout");
    expect(out.error).toMatch(/wall-clock budget exhausted \(300 ms\)/);
  });

  it("enforces the turn budget", async () => {
    const out = await provider({ maxTurns: 1 }).execute("FIXTURE write-receipt", ctx());
    expect(out.trajectory?.stop).toBe("max_turns");
    expect(out.error).toMatch(/turn budget exhausted \(1 turns\)/);
  });

  it("maps a CLI that dies without a result to a typed provider failure", async () => {
    const err = await provider()
      .execute("CRASH", ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).category).toBe("authentication");
  });

  it("builds subscription-only, project-scoped claude args", () => {
    expect(buildClaudeArgs("hi", "haiku", ["Bash", "Read"], 0.5)).toEqual([
      "-p",
      "hi",
      "--model",
      "haiku",
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--tools",
      "Bash",
      "Read",
      "--allowedTools",
      "Bash",
      "Read",
      "--max-budget-usd",
      "0.5",
    ]);
    expect(sandboxEnv({ PATH: "/bin", ANTHROPIC_AUTH_TOKEN: "x" }, "/h")).toEqual({
      PATH: "/bin",
      HOME: "/h",
      CLAUDE_CONFIG_DIR: "/h/.claude",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    });
  });

  it("diffs manifests into created / modified / unchanged / deleted, sorted", () => {
    const before = new Map([
      ["b", { sha256: "1" }],
      ["c", { sha256: "2" }],
      ["d", { sha256: "3" }],
    ]);
    const after = new Map([
      ["c", { sha256: "2", size: 1 }],
      ["b", { sha256: "9", size: 1 }],
      ["a", { sha256: "4", size: 1 }],
    ]);
    expect(diffManifests(before, after).map((f) => [f.path, f.change])).toEqual([
      ["a", "created"],
      ["b", "modified"],
      ["c", "unchanged"],
      ["d", "deleted"],
    ]);
  });
});

describe("j-rig eval --execution-provider flag resolution", () => {
  it("is off by default and rejects claude-code flags without it", () => {
    expect(resolveClaudeCodeSettings({})).toBeUndefined();
    expect(() => resolveClaudeCodeSettings({ claudeCodeMaxTurns: "3" })).toThrow(
      /require --execution-provider claude-code/,
    );
  });

  it("parses budgets and refuses incompatible combinations", () => {
    expect(
      resolveClaudeCodeSettings({
        executionProvider: "claude-code",
        claudeCodeMaxTurns: "10",
        claudeCodeTimeoutMs: "60000",
        claudeCodeMaxBudgetUsd: "0.25",
      }),
    ).toEqual({ maxTurns: 10, timeoutMs: 60000, maxBudgetUsd: 0.25 });
    expect(() => resolveClaudeCodeSettings({ executionProvider: "codex" })).toThrow(
      /must be "claude-code"/,
    );
    expect(() =>
      resolveClaudeCodeSettings({ executionProvider: "claude-code", claudeCodeMaxTurns: "2.5" }),
    ).toThrow(/positive integer/);
    expect(() =>
      resolveClaudeCodeSettings({ executionProvider: "claude-code", functional: false }),
    ).toThrow(/requires functional execution/);
    expect(() =>
      resolveClaudeCodeSettings({ executionProvider: "claude-code", mcpConfig: "x.json" }),
    ).toThrow(/cannot be combined/);
  });
});
