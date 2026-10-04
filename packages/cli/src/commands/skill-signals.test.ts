import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, countVerifiedUsage, countReviews } from "@j-rig/db";
import * as jrigDb from "@j-rig/db";
import * as dbLib from "../lib/db.js";
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

  it("closes the SQLite connection after a successful ingest (no leak)", async () => {
    const db = scratchDb();
    const close = vi.fn();
    const real = createDatabase(db);
    vi.spyOn(dbLib, "openDb").mockReturnValue({ ...real, close });
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
        "--db",
        db,
        "--json",
      ],
      { from: "user" },
    );
    expect(close).toHaveBeenCalledTimes(1);
    real.close();
  });

  it("closes the SQLite connection even when the write throws (no leak on error)", async () => {
    const db = scratchDb();
    const close = vi.fn();
    const real = createDatabase(db);
    // Open succeeds, then the record write throws — proving the `finally` releases
    // the handle on the error path, not just on success.
    vi.spyOn(dbLib, "openDb").mockReturnValue({ ...real, close });
    vi.spyOn(jrigDb, "recordSkillUsage").mockImplementation(() => {
      throw new Error("boom");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(
      program().parseAsync(["ingest-skill", "k", "--session-id", "s", "--db", db], {
        from: "user",
      }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(errs.join("\n")).toContain("boom");
    exit.mockRestore();
    real.close();
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

  it("closes the SQLite connection after a successful review (no leak)", async () => {
    const db = scratchDb();
    const close = vi.fn();
    const real = createDatabase(db);
    vi.spyOn(dbLib, "openDb").mockReturnValue({ ...real, close });
    await program().parseAsync(
      ["review", "k", "--verdict", "up", "--reviewer", "a", "--db", db, "--json"],
      { from: "user" },
    );
    expect(close).toHaveBeenCalledTimes(1);
    real.close();
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

  it("prints a human-readable thumb-up with rationale and the curated-signal disclaimer", async () => {
    const db = scratchDb();
    await program().parseAsync(
      [
        "review",
        "commit-writer",
        "--verdict",
        " UP ",
        "--rationale",
        "clear output",
        "--reviewer",
        "rev-1",
        "--tenant",
        "tenant-b",
        "--db",
        db,
      ],
      { from: "user" },
    );
    const text = logs.join("\n");
    expect(text).toContain("j-rig review: commit-writer");
    expect(text).toContain("thumb up by rev-1 (curated-signal)");
    expect(text).toContain("rationale: clear output");
    expect(text).toContain("NOT a signed human-review/v1 predicate");
    const verify = createDatabase(db);
    expect(countReviews(verify, "commit-writer")).toEqual([
      { skillId: "commit-writer", direction: "up", tenantId: "tenant-b", count: 1 },
    ]);
    verify.close();
  });

  it("prints a thumb-down without a rationale line when none was given", async () => {
    const db = scratchDb();
    await program().parseAsync(["review", "k", "--verdict", "down", "--db", db], {
      from: "user",
    });
    const text = logs.join("\n");
    expect(text).toContain("thumb down by unknown");
    expect(text).not.toContain("rationale:");
  });

  it("closes the SQLite connection and exits 1 when the review write throws", async () => {
    const db = scratchDb();
    const close = vi.fn();
    const real = createDatabase(db);
    vi.spyOn(dbLib, "openDb").mockReturnValue({ ...real, close });
    vi.spyOn(jrigDb, "recordSkillReview").mockImplementation(() => {
      throw "review store offline";
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(
      program().parseAsync(["review", "k", "--verdict", "up", "--db", db], { from: "user" }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(errs.join("\n")).toContain("Error: review store offline");
    expect(exit).toHaveBeenCalledWith(1);
    real.close();
  });
});

describe("j-rig ingest-skill — human-readable output", () => {
  it("prints a PASS line with the tenant bucket for a passing session", async () => {
    const db = scratchDb();
    await program().parseAsync(
      [
        "ingest-skill",
        "commit-writer",
        "--session-id",
        "s-pass",
        "--source",
        " CI ",
        "--tests-passed",
        "--clear-resolution",
        "--tenant",
        "tenant-a",
        "--db",
        db,
      ],
      { from: "user" },
    );
    const text = logs.join("\n");
    expect(text).toContain("j-rig ingest-skill: commit-writer");
    expect(text).toContain("PASS — counts toward verified adoption");
    expect(text).toContain("source: ci | tenant: tenant-a");
    expect(text).not.toContain("never counted");
  });

  it("prints a FAIL line and the anti-gaming note for a failing session with no tenant", async () => {
    const db = scratchDb();
    await program().parseAsync(["ingest-skill", "k", "--session-id", "s-fail", "--db", db], {
      from: "user",
    });
    const text = logs.join("\n");
    expect(text).toContain("FAIL — persisted but EXCLUDED from adoption (anti-gaming)");
    expect(text).toMatch(/source: plugin$/m);
    expect(text).toContain("There is no force-count flag.");
  });
});
