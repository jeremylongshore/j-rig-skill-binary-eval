import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, countVerifiedUsage, countReviews } from "@j-rig/db";
import { registerSkillSignalCommands } from "./skill-signals.js";

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

function scratchDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "j-rig-skill-signals-cli-"));
  created.push(dir);
  return join(dir, "j-rig.db");
}

/** Build a fresh program with the two verbs registered, exiting via a throw. */
function program(): Command {
  const p = new Command();
  p.exitOverride();
  registerSkillSignalCommands(p);
  return p;
}

describe("ingest-skill + review — registration", () => {
  it("registers both verbs on the program", () => {
    const names = program()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toContain("ingest-skill");
    expect(names).toContain("review");
  });
});

describe("j-rig ingest-skill", () => {
  it("persists a CASS-PASSING ci usage row and counts it", async () => {
    const db = scratchDb();
    await program().parseAsync(
      [
        "ingest-skill",
        "commit-writer",
        "--session-id",
        "s1",
        "--source",
        "ci",
        "--tests-passed",
        "--clear-resolution",
        "--db",
        db,
        "--json",
      ],
      { from: "user" },
    );
    const out = JSON.parse(logs.join("\n"));
    expect(out.cassPassed).toBe(true);
    expect(out.source).toBe("ci");

    const verify = createDatabase(db);
    const counts = countVerifiedUsage(verify, "commit-writer");
    expect(counts).toHaveLength(1);
    expect(counts[0]!.verifiedCount).toBe(1);
    verify.close();
  });

  it("persists a FAILING (gamed) usage row but EXCLUDES it from the verified count", async () => {
    const db = scratchDb();
    // No CASS quality flags ⇒ score 0 ⇒ FAIL. A raw "load in a loop".
    await program().parseAsync(
      ["ingest-skill", "commit-writer", "--session-id", "s-gamed", "--db", db, "--json"],
      { from: "user" },
    );
    const out = JSON.parse(logs.join("\n"));
    expect(out.cassPassed).toBe(false);

    const verify = createDatabase(db);
    // Row IS persisted (visible)...
    const all = verify.sqlite.prepare("SELECT COUNT(*) AS n FROM skill_usage_events").get() as {
      n: number;
    };
    expect(all.n).toBe(1);
    // ...but NOT counted.
    expect(countVerifiedUsage(verify, "commit-writer")).toHaveLength(0);
    verify.close();
  });

  it("rejects an invalid --source", async () => {
    const db = scratchDb();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(
      program().parseAsync(
        ["ingest-skill", "k", "--session-id", "s", "--source", "bogus", "--db", db],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(errs.join("\n")).toContain("--source must be 'ci' or 'plugin'");
    exit.mockRestore();
  });

  it("carries a tenant bucket onto the row", async () => {
    const db = scratchDb();
    await program().parseAsync(
      [
        "ingest-skill",
        "k",
        "--session-id",
        "s",
        "--source",
        "ci",
        "--tests-passed",
        "--clear-resolution",
        "--tenant",
        "tenant-a",
        "--db",
        db,
        "--json",
      ],
      { from: "user" },
    );
    const out = JSON.parse(logs.join("\n"));
    expect(out.tenantId).toBe("tenant-a");
  });
});

describe("j-rig review", () => {
  it("records a curated-signal thumb-up with a rationale", async () => {
    const db = scratchDb();
    await program().parseAsync(
      [
        "review",
        "commit-writer",
        "--verdict",
        "up",
        "--rationale",
        "saved me time",
        "--reviewer",
        "jeremy@intentsolutions.io",
        "--db",
        db,
        "--json",
      ],
      { from: "user" },
    );
    const out = JSON.parse(logs.join("\n"));
    expect(out.governanceClass).toBe("curated-signal");
    expect(out.thumbsUp).toBe(true);
    expect(out.rationale).toBe("saved me time");

    const verify = createDatabase(db);
    const counts = countReviews(verify, "commit-writer");
    expect(counts.find((c) => c.direction === "up")!.count).toBe(1);
    verify.close();
  });

  it("rejects an invalid --verdict", async () => {
    const db = scratchDb();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(
      program().parseAsync(["review", "k", "--verdict", "maybe", "--db", db], { from: "user" }),
    ).rejects.toThrow();
    expect(errs.join("\n")).toContain("--verdict must be 'up' or 'down'");
    exit.mockRestore();
  });

  it("allows a thumb-only review (no rationale)", async () => {
    const db = scratchDb();
    await program().parseAsync(
      ["review", "k", "--verdict", "down", "--reviewer", "a", "--db", db, "--json"],
      { from: "user" },
    );
    const out = JSON.parse(logs.join("\n"));
    expect(out.thumbsUp).toBe(false);
    expect(out.rationale).toBeNull();
  });
});
