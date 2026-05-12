import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMM1AsyncRace } from "./mm-1-async-race.js";
import { runChecker, runAllRegisteredCheckers, MM_CHECKERS } from "./registry.js";
import type { MMFixture } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../fixtures/mm-traces/MM-1");

function readFixture(name: string): MMFixture {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), "utf-8")) as MMFixture;
}

describe("checkMM1AsyncRace", () => {
  it("returns PASS when reconciliation hook fires between async write and downstream read", () => {
    const fixture = readFixture("pass-reconciled.json");
    const result = checkMM1AsyncRace(fixture.events);
    expect(result.category).toBe("MM-1");
    expect(result.result).toBe(fixture.expected);
    expect(result.result).toBe("PASS");
    expect(result.metadata?.passes).toBe(1);
    expect(result.metadata?.fails).toBe(0);
  });

  it("returns FAIL when downstream read sees stale_state without reconciliation", () => {
    const fixture = readFixture("fail-stale-read.json");
    const result = checkMM1AsyncRace(fixture.events);
    expect(result.result).toBe(fixture.expected);
    expect(result.result).toBe("FAIL");
    expect(result.metadata?.fails).toBe(1);
  });

  it("returns NOT_APPLICABLE when no async-write tool decisions occurred", () => {
    const fixture = readFixture("not-applicable-no-async-write.json");
    const result = checkMM1AsyncRace(fixture.events);
    expect(result.result).toBe(fixture.expected);
    expect(result.result).toBe("NOT_APPLICABLE");
    expect(result.reason).toMatch(/no asynchronous write-side tool calls/);
  });

  it("returns NOT_APPLICABLE on an empty trace", () => {
    const result = checkMM1AsyncRace([]);
    expect(result.result).toBe("NOT_APPLICABLE");
  });

  it("counts async write with no downstream read as a pass (race cannot manifest)", () => {
    const events = [
      {
        name: "claude_code.tool_decision",
        timestamp: "2026-05-12T05:30:00.000Z",
        attributes: { "tool.async": true, "tool.kind": "write", server: "s1" },
      },
    ];
    const result = checkMM1AsyncRace(events);
    expect(result.result).toBe("PASS");
    expect(result.metadata?.writes).toBe(1);
    expect(result.metadata?.passes).toBe(1);
  });

  it("does not credit a hook fired BEFORE the async write", () => {
    const events = [
      {
        name: "claude_code.hook_execution_complete",
        timestamp: "2026-05-12T05:35:00.000Z",
        attributes: { "hook.handler": "reconcile-after-async-write" },
      },
      {
        name: "claude_code.tool_decision",
        timestamp: "2026-05-12T05:35:01.000Z",
        attributes: { "tool.async": true, "tool.kind": "write", server: "s1" },
      },
      {
        name: "claude_code.tool_result",
        timestamp: "2026-05-12T05:35:02.000Z",
        attributes: { "tool.kind": "read", server: "s1", stale_state: false },
      },
    ];
    const result = checkMM1AsyncRace(events);
    expect(result.result).toBe("FAIL");
    expect((result.metadata?.findings as unknown[])?.length).toBe(1);
  });

  it("requires the downstream read to target the same server as the async write", () => {
    const events = [
      {
        name: "claude_code.tool_decision",
        timestamp: "2026-05-12T05:40:00.000Z",
        attributes: { "tool.async": true, "tool.kind": "write", server: "server_a" },
      },
      {
        name: "claude_code.tool_result",
        timestamp: "2026-05-12T05:40:01.000Z",
        attributes: { "tool.kind": "read", server: "server_b", stale_state: false },
      },
    ];
    // Read on a different server doesn't count as a downstream read pair.
    // → write has no downstream → counted as pass-by-vacuity (race cannot manifest).
    const result = checkMM1AsyncRace(events);
    expect(result.result).toBe("PASS");
  });
});

describe("registry", () => {
  it("dispatches MM-1 to the registered checker", () => {
    const fixture = readFixture("pass-reconciled.json");
    const result = runChecker("MM-1", fixture.events);
    expect(result.result).toBe("PASS");
  });

  it("returns NOT_APPLICABLE-with-note for unregistered MM categories (partial coverage is valid)", () => {
    // Cast a hypothetical future MM category that has not yet been
    // registered. The registry's contract is "missing entry → friendly
    // NOT_APPLICABLE", which protects callers from throwing when partial
    // coverage is intentional (Evidence Bundle SPEC § R2).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = runChecker("MM-99" as any, []);
    expect(result.result).toBe("NOT_APPLICABLE");
    expect(result.reason).toMatch(/no checker registered/);
  });

  it("runAllRegisteredCheckers runs every registered checker and returns one result each", () => {
    const fixture = readFixture("not-applicable-no-async-write.json");
    const results = runAllRegisteredCheckers(fixture.events);
    expect(results).toHaveLength(Object.keys(MM_CHECKERS).length);
    expect(results.every((r) => ["PASS", "FAIL", "NOT_APPLICABLE"].includes(r.result))).toBe(true);
  });
});
