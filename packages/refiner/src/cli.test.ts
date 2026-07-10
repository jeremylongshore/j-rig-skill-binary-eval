import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { RefinerStore, type FileSystem } from "./store.js";
import { registerRefineCommand } from "./cli.js";

/** Shared in-memory FileSystem so every command in a test sees the same store. */
class MemoryFileSystem implements FileSystem {
  readonly files = new Map<string, string>();
  readFile(path: string): string | null {
    return this.files.has(path) ? this.files.get(path)! : null;
  }
  writeFile(path: string, data: string): void {
    this.files.set(path, data);
  }
  appendFile(path: string, data: string): void {
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }
  mkdirp(): void {}
  exists(path: string): boolean {
    return this.files.has(path);
  }
}

/**
 * Build a program with the refine group registered against ONE shared
 * memory-fs store, plus a real on-disk skill dir for SKILL.md reads.
 */
function setup(): {
  program: Command;
  store: RefinerStore;
  skillDir: string;
  cleanup: () => void;
} {
  const fs = new MemoryFileSystem();
  const store = new RefinerStore({ fs, root: "/proj", clock: () => "2026-06-17T00:00:00.000Z" });
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on parse errors
  registerRefineCommand(program, () => store);

  const dir = mkdtempSync(join(tmpdir(), "refiner-cli-"));
  const skillDir = join(dir, "demo-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: demo-skill\ndescription: A demo skill.\n---\n\n# Demo\n\nDo the procedural thing carefully and report the outcome.\n",
    "utf8",
  );
  return { program, store, skillDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(program: Command, argv: string[]): Promise<void> {
  await program.parseAsync(["node", "j-rig", ...argv]);
}

describe("registerRefineCommand — registration shape (build-order step 7)", () => {
  it("registers a `refine` group with the 6 documented subcommands", () => {
    const { program, cleanup } = setup();
    try {
      const refine = program.commands.find((c) => c.name() === "refine");
      expect(refine).toBeDefined();
      const subs = refine!.commands.map((c) => c.name()).sort();
      expect(subs).toEqual(["apply", "bootstrap", "propose", "render-report", "score", "status"]);
    } finally {
      cleanup();
    }
  });
});

describe("`j-rig refine render-report` — deterministic markdown → HTML", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it("renders a canonical report to a self-contained HTML file", async () => {
    const { program, cleanup } = setup();
    const dir = mkdtempSync(join(tmpdir(), "refiner-report-"));
    try {
      const md = [
        "# Skill Refiner Evidence Report — demo — 2026-06-30",
        "",
        "| Field   | Value  |",
        "| ------- | ------ |",
        "| Verdict | accept |",
        "",
        "## 1. Context",
        "manual trigger.",
        "## 2. Eval set composition",
        "N = 8 synthetic.",
        "## 3. Score trajectory",
        "",
        "| Dimension  | Baseline | Candidate | Delta   | Non-regressed |",
        "| ---------- | -------- | --------- | ------- | ------------- |",
        "| behavioral | 0.7000   | 0.8000    | +0.1000 | —             |",
        "",
        "## 4. Accepted edits (replayable)",
        "one replace op.",
        "## 5. Rejected edits (audit trail)",
        "none.",
        "## 6. Hook-layer gate evidence (per pass)",
        "line (L2).",
        "## 7. Signed Evidence Bundle (in-toto Statement v1)",
        "https://evals.intentsolutions.io/skill-refiner-pass/v1",
        "## 8. Architectural bindings",
        "DR-010.",
        "## 9. Limitations + risks",
        "bounded by the eval-set.",
        "## 10. Status banding",
        "Status: `ACTIVE`.",
        "",
      ].join("\n");
      const mdPath = join(dir, "report.md");
      const htmlPath = join(dir, "report.html");
      writeFileSync(mdPath, md, "utf8");

      await run(program, ["refine", "render-report", mdPath, "--output", htmlPath]);

      const html = readFileSync(htmlPath, "utf8");
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('class="verdict accept"');
      expect(html).toContain("<svg");
      expect(html).not.toContain("labs.intentsolutions.io");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("fails loudly on a non-conforming report (missing sections)", async () => {
    const { program, cleanup } = setup();
    const dir = mkdtempSync(join(tmpdir(), "refiner-report-bad-"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mdPath = join(dir, "bad.md");
      writeFileSync(
        mdPath,
        "# Bad report\n\n| Field | Value |\n| - | - |\n| Verdict | accept |\n",
        "utf8",
      );
      await expect(run(program, ["refine", "render-report", mdPath])).rejects.toThrow("exit");
      expect(err).toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      err.mockRestore();
      rmSync(dir, { recursive: true, force: true });
      cleanup();
    }
  });
});

describe("`j-rig refine bootstrap` — offline, deterministic", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it("bootstraps an eval set + persists the doc and set", async () => {
    const { program, store, skillDir, cleanup } = setup();
    try {
      await run(program, ["refine", "bootstrap", skillDir]);
      const kinds = store.readLog().flatMap((e) => (e.type === "stored" ? [e.kind] : []));
      expect(kinds).toContain("skill-doc");
      expect(kinds).toContain("eval-set");
      expect(log).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("emits JSON with --json", async () => {
    const { program, skillDir, cleanup } = setup();
    try {
      await run(program, ["refine", "bootstrap", skillDir, "--json"]);
      const printed = String(log.mock.calls.at(-1)?.[0]);
      const parsed = JSON.parse(printed);
      expect(parsed.source).toBe("synthetic");
      expect(parsed.skillId).toBe("demo-skill");
    } finally {
      cleanup();
    }
  });
});

describe("`j-rig refine apply` — offline, append-only", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it("applies a stored proposal → a new immutable version", async () => {
    const { program, store, skillDir, cleanup } = setup();
    try {
      // Seed: bootstrap to store the doc, then hand-store a proposal against it.
      // The proposal's `parent` is the doc's OWN content hash (text hash), which
      // is what applyEdit checks — distinct from the store's value-address key.
      await run(program, ["refine", "bootstrap", skillDir]);
      const storedDoc = store
        .readLog()
        .flatMap((e) => (e.type === "stored" && e.kind === "skill-doc" ? [e.hash] : []))
        .map((h) => store.get<{ hash: string }>(h)!)[0];
      const proposalHash = store.putEditProposal({
        parent: storedDoc.hash,
        ops: [{ kind: "replace", target: "carefully", content: "with care" }],
        refinerModel: "claude-sonnet-4-5",
        refinerStrategyId: "skill-opt-style/v1",
        rationale: "tighten",
      });
      await run(program, ["refine", "apply", skillDir, "--proposal", proposalHash]);
      // The applied version is a NEW skill-doc address (append-only).
      const docKinds = store.readLog().filter((e) => e.type === "stored" && e.kind === "skill-doc");
      expect(docKinds.length).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe("`j-rig refine status` — offline", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it("reports an unset best + zero events for an unknown skill (--json)", async () => {
    const { program, cleanup } = setup();
    try {
      await run(program, ["refine", "status", "nobody", "--json"]);
      const parsed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(parsed.best).toBeNull();
      expect(parsed.events).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("reports the best pointer + events after bootstrap", async () => {
    const { program, store, skillDir, cleanup } = setup();
    try {
      await run(program, ["refine", "bootstrap", skillDir]);
      const docHash = store
        .readLog()
        .flatMap((e) => (e.type === "stored" && e.kind === "skill-doc" ? [e.hash] : []))[0];
      store.setBest("demo-skill", docHash);
      await run(program, ["refine", "status", "demo-skill", "--json"]);
      const parsed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(parsed.best).toBe(docHash);
      expect(parsed.events.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

describe("`j-rig refine score` / `propose` — guard rails", () => {
  let err: MockInstance<typeof console.error>;
  let exit: MockInstance<typeof process.exit>;
  // Provider key env vars that resolveProvider() consults. Guard-rail tests run
  // with a CONTROLLED environment: every one is cleared up front, then each test
  // sets exactly the key(s) it needs. This makes the provider-agnostic paths
  // deterministic regardless of what keys the developer/CI environment happens
  // to expose.
  const PROVIDER_KEY_ENVS = [
    "ANTHROPIC_API_KEY",
    "NVIDIA_API_KEY",
    "DEEPSEEK_API_KEY",
    "GROQ_API_KEY",
    "MOONSHOT_API_KEY",
    "OPENROUTER_API_KEY",
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_PROVIDER",
  ];
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = {};
    for (const k of PROVIDER_KEY_ENVS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    // `fail()` calls process.exit(1); throw instead so the test can assert it.
    exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as typeof process.exit);
  });
  afterEach(() => {
    for (const k of PROVIDER_KEY_ENVS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
    err.mockRestore();
    exit.mockRestore();
  });

  it("score rejects an opus tier on the anthropic provider (validation-only)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-1234-not-real";
    const { program, skillDir, cleanup } = setup();
    try {
      await expect(
        run(program, ["refine", "score", skillDir, "--provider", "anthropic", "--model", "opus"]),
      ).rejects.toThrow();
      expect(err).toHaveBeenCalled();
      expect(String(err.mock.calls[0][0])).toMatch(/haiku or sonnet/);
    } finally {
      cleanup();
    }
  });

  it("score refuses when NO provider key is set (Anthropic NOT required)", async () => {
    const { program, skillDir, cleanup } = setup();
    try {
      await expect(run(program, ["refine", "score", skillDir])).rejects.toThrow();
      // The error lists the env vars it looked for, incl. the free ones — never
      // singling out Anthropic as required.
      expect(String(err.mock.calls[0][0])).toMatch(/no LLM provider credential found/);
      expect(String(err.mock.calls[0][0])).toMatch(/NVIDIA_API_KEY/);
    } finally {
      cleanup();
    }
  });

  it("propose refuses when NO provider key is set (Anthropic NOT required)", async () => {
    const { program, skillDir, cleanup } = setup();
    try {
      await expect(run(program, ["refine", "propose", skillDir])).rejects.toThrow();
      const msg = String(err.mock.calls[0][0]);
      expect(msg).toMatch(/does NOT require Anthropic/);
      expect(msg).toMatch(/NVIDIA_API_KEY/);
    } finally {
      cleanup();
    }
  });

  it("propose fails loud when --provider names a backend with no key", async () => {
    // Only a free key is present, but the operator explicitly asked for anthropic.
    process.env.NVIDIA_API_KEY = "nvidia-key-1234-not-real";
    const { program, skillDir, cleanup } = setup();
    try {
      await expect(
        run(program, ["refine", "propose", skillDir, "--provider", "anthropic"]),
      ).rejects.toThrow();
      expect(String(err.mock.calls[0][0])).toMatch(/ANTHROPIC_API_KEY is not set/);
    } finally {
      cleanup();
    }
  });

  it("propose rejects an opus tier on anthropic before touching the wire", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-1234-not-real";
    const { program, skillDir, cleanup } = setup();
    try {
      await expect(
        run(program, ["refine", "propose", skillDir, "--provider", "anthropic", "--model", "opus"]),
      ).rejects.toThrow();
      expect(String(err.mock.calls[0][0])).toMatch(/haiku or sonnet/);
    } finally {
      cleanup();
    }
  });

  it("propose rejects an unknown strategy (after a provider resolves)", async () => {
    process.env.NVIDIA_API_KEY = "nvidia-key-1234-not-real";
    const { program, skillDir, cleanup } = setup();
    try {
      await expect(
        run(program, ["refine", "propose", skillDir, "--strategy", "nope"]),
      ).rejects.toThrow();
      expect(String(err.mock.calls[0][0])).toMatch(/unknown refiner strategy/);
    } finally {
      cleanup();
    }
  });

  it("score reports a missing eval set", async () => {
    process.env.NVIDIA_API_KEY = "nvidia-key-1234-not-real";
    const { program, skillDir, cleanup } = setup();
    try {
      await expect(
        run(program, ["refine", "score", skillDir, "--eval-set", "f".repeat(64)]),
      ).rejects.toThrow();
      expect(String(err.mock.calls[0][0])).toMatch(/not found in the refiner store/);
    } finally {
      cleanup();
    }
  });

  it("apply reports a missing proposal", async () => {
    const { program, skillDir, cleanup } = setup();
    try {
      await expect(
        run(program, ["refine", "apply", skillDir, "--proposal", "f".repeat(64)]),
      ).rejects.toThrow();
      expect(String(err.mock.calls[0][0])).toMatch(/not found in the refiner store/);
    } finally {
      cleanup();
    }
  });
});
