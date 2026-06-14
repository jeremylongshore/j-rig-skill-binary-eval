import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerParseAgentsCommand, runParseAgents } from "./parse-agents.js";

let logs: string[];
let errs: string[];
const created: string[] = [];

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation(((...a: unknown[]) => {
    logs.push(a.join(" "));
  }) as never);
  vi.spyOn(console, "error").mockImplementation(((...a: unknown[]) => {
    errs.push(a.join(" "));
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratchFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "j-rig-parse-agents-"));
  created.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const SAMPLE = `# My Project

## Setup commands

\`\`\`bash
pnpm install
\`\`\`

## Test

\`\`\`bash
pnpm test
\`\`\`

## Tools

- ripgrep
- jq

## Constraints

- never force-push
`;

describe("parse-agents command — registration", () => {
  it("registers on the program", () => {
    const program = new Command();
    registerParseAgentsCommand(program);
    const cmd = program.commands.find((c) => c.name() === "parse-agents");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/AGENTS\.md/);
  });
});

describe("runParseAgents", () => {
  it("parses a well-formed AGENTS.md and prints a summary (exit 0)", () => {
    const path = scratchFile("AGENTS.md", SAMPLE);
    const code = runParseAgents(path, {});
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("Parsed");
    expect(out).toContain("Title: My Project");
    expect(out).toContain("Sections: 4");
    expect(out).toContain("Tools: 2");
    expect(out).toContain("Constraints: 1");
  });

  it("emits JSON with --json (exit 0)", () => {
    const path = scratchFile("AGENTS.md", SAMPLE);
    const code = runParseAgents(path, { json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.data.title).toBe("My Project");
    expect(parsed.data.commands.setup).toContain("pnpm install");
    expect(parsed.data.commands.test).toContain("pnpm test");
  });

  it("reports a parse failure on broken frontmatter (exit 1)", () => {
    const broken = "---\n: : not yaml :\n---\n# x\n";
    const path = scratchFile("AGENTS.md", broken);
    const code = runParseAgents(path, {});
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("Failed to parse");
  });

  it("emits a JSON error envelope with --json on broken frontmatter (exit 1)", () => {
    const broken = "---\n: : not yaml :\n---\n# x\n";
    const path = scratchFile("AGENTS.md", broken);
    const code = runParseAgents(path, { json: true });
    expect(code).toBe(1);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("returns 1 with a runtime error when the file is missing", () => {
    const code = runParseAgents(join(tmpdir(), "definitely-missing-agents-xyz.md"), {});
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("Error:");
  });

  it("shows (none) when there is no title", () => {
    const path = scratchFile("AGENTS.md", "## Just a section\n\nbody\n");
    const code = runParseAgents(path, {});
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("(none)");
  });

  it("does not print empty optional sections", () => {
    const path = scratchFile("AGENTS.md", "# Title only\n\n## Notes\n\nplain text\n");
    const code = runParseAgents(path, {});
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).not.toContain("Tools:");
    expect(out).not.toContain("Capabilities:");
    expect(out).not.toContain("Commands:");
  });
});
