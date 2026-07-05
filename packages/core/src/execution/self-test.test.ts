import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SelfTestSchema, type SelfTest } from "../schemas/self-test.js";
import {
  buildSelfTestCriterion,
  runSelfTest,
  summarizeSelfTest,
  toSelfTestJudgment,
  tokenizeCommand,
} from "./self-test.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway skill dir containing one node script. */
function skillDir(scriptName: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jrig-selftest-"));
  writeFileSync(join(dir, scriptName), body, "utf8");
  dirs.push(dir);
  return dir;
}

/** Build a SelfTest through the schema so defaults (expect_exit, blocker) apply. */
function spec(command: string, extra: Partial<SelfTest> = {}): SelfTest {
  return SelfTestSchema.parse({ command, ...extra });
}

describe("runSelfTest", () => {
  it("passes when the script exits with the expected code", () => {
    const dir = skillDir(
      "ok.js",
      'console.log("self-test: 3 passed, 0 failed");\nprocess.exit(0);',
    );
    const r = runSelfTest(spec("node ok.js"), dir);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("3 passed");
    expect(r.error).toBeUndefined();
  });

  it("fails when the exit code differs from expect_exit", () => {
    const dir = skillDir(
      "bad.js",
      'console.log("self-test: 1 passed, 2 failed");\nprocess.exit(1);',
    );
    const r = runSelfTest(spec("node bad.js"), dir);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it("honors a non-zero expect_exit", () => {
    const dir = skillDir("two.js", "process.exit(2);");
    const r = runSelfTest(spec("node two.js", { expect_exit: 2 }), dir);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(2);
  });

  it("resolves relative script paths against the skill dir (cwd)", () => {
    const dir = skillDir("scripts-check.js", "process.exit(0);");
    // Run from the skill dir; the relative path must resolve there.
    const r = runSelfTest(spec("node scripts-check.js"), dir);
    expect(r.passed).toBe(true);
  });

  it("handles a quoted argument that contains a space", () => {
    const dir = skillDir("with space.js", "process.exit(0);");
    const r = runSelfTest(spec('node "with space.js"'), dir);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
  });

  it("fails closed when the interpreter cannot be spawned", () => {
    const dir = skillDir("x.js", "");
    const r = runSelfTest(spec("definitely-not-a-real-binary-xyz x.js"), dir);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.error).toMatch(/could not run/i);
  });

  it("fails closed on an empty command", () => {
    const dir = skillDir("x.js", "");
    const r = runSelfTest({ command: "   ", expect_exit: 0, blocker: true }, dir);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.error).toMatch(/empty/i);
  });

  it("fails closed on timeout", () => {
    const dir = skillDir("hang.js", "setTimeout(() => {}, 60000);");
    const r = runSelfTest(spec("node hang.js"), dir, { timeoutMs: 300 });
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/timed out/i);
  });

  it("does NOT forward inherited env (e.g. an API key) to the script", () => {
    // The script exits 3 if it can see the sentinel, 0 if it cannot.
    process.env.JRIG_SELFTEST_SENTINEL = "leaked-key-value";
    try {
      const dir = skillDir("env.js", "process.exit(process.env.JRIG_SELFTEST_SENTINEL ? 3 : 0);");
      const r = runSelfTest(spec("node env.js"), dir);
      expect(r.exitCode).toBe(0); // sentinel was scoped out of the child env
    } finally {
      delete process.env.JRIG_SELFTEST_SENTINEL;
    }
  });
});

describe("tokenizeCommand", () => {
  it("splits a simple command on whitespace", () => {
    expect(tokenizeCommand("python3 scripts/triage.py --self-test")).toEqual([
      "python3",
      "scripts/triage.py",
      "--self-test",
    ]);
  });

  it("keeps a double-quoted argument with spaces intact", () => {
    expect(tokenizeCommand('node "my dir/x.py" --flag')).toEqual(["node", "my dir/x.py", "--flag"]);
  });

  it("keeps a single-quoted argument intact", () => {
    expect(tokenizeCommand("node -e 'a b c'")).toEqual(["node", "-e", "a b c"]);
  });

  it("collapses runs of whitespace and returns [] for empty", () => {
    expect(tokenizeCommand("  node   x.js  ")).toEqual(["node", "x.js"]);
    expect(tokenizeCommand("   ")).toEqual([]);
  });
});

describe("summarizeSelfTest", () => {
  it("surfaces the script's tally line when present", () => {
    const dir = skillDir(
      "ok.js",
      'console.log("self-test: 18 passed, 0 failed");\nprocess.exit(0);',
    );
    const summary = summarizeSelfTest(runSelfTest(spec("node ok.js"), dir));
    expect(summary).toContain("exit 0 (expected 0)");
    expect(summary).toContain("18 passed, 0 failed");
  });

  it("returns the error message when the run failed to start", () => {
    const dir = skillDir("x.js", "");
    const summary = summarizeSelfTest(runSelfTest(spec("nope-xyz x.js"), dir));
    expect(summary).toMatch(/could not run/i);
  });
});

describe("toSelfTestJudgment", () => {
  it("maps a pass to verdict=yes (deterministic)", () => {
    const dir = skillDir("ok.js", "process.exit(0);");
    const j = toSelfTestJudgment(runSelfTest(spec("node ok.js"), dir));
    expect(j).toMatchObject({ criterion_id: "self-test", verdict: "yes", method: "deterministic" });
    expect(j.confidence).toBe(1);
  });

  it("maps a fail to verdict=no", () => {
    const dir = skillDir("bad.js", "process.exit(1);");
    const j = toSelfTestJudgment(runSelfTest(spec("node bad.js"), dir));
    expect(j.verdict).toBe("no");
  });
});

describe("buildSelfTestCriterion", () => {
  it("is a deterministic blocker criterion by default", () => {
    expect(buildSelfTestCriterion(spec("node x.js"))).toMatchObject({
      id: "self-test",
      method: "deterministic",
      blocker: true,
    });
  });

  it("respects blocker:false", () => {
    expect(buildSelfTestCriterion(spec("node x.js", { blocker: false })).blocker).toBe(false);
  });
});
