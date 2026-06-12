import { describe, it, expect } from "vitest";
import { runCisoGateG1, findKeySubstrings } from "./g1-credential-redaction.js";
import { CleanProvider } from "../test-fixtures/clean-provider.js";
import { LeakyProvider } from "../test-fixtures/leaky-provider.js";

const TEST_KEY = "sk-test-G1-aaaa1111bbbb2222cccc3333dddd4444";

describe("findKeySubstrings", () => {
  it("returns empty when key is too short", () => {
    expect(findKeySubstrings("anything", "short", 8)).toEqual([]);
  });

  it("returns empty when no substring of key appears in haystack", () => {
    expect(findKeySubstrings("totally unrelated text", TEST_KEY, 8)).toEqual([]);
  });

  it("detects exact key match", () => {
    const result = findKeySubstrings(`prefix ${TEST_KEY} suffix`, TEST_KEY, 8);
    expect(result).toContain(TEST_KEY);
  });

  it("detects 8-char substring of the key", () => {
    const substr = TEST_KEY.slice(5, 18);
    const result = findKeySubstrings(`abcdef ${substr} ghi`, TEST_KEY, 8);
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((r) => r.includes(substr))).toBe(true);
  });

  it("reports the maximal contiguous match, not every overlapping window", () => {
    // If the key 'abcdefghij' appears in 'xx abcdefghij xx', the maximal
    // match is the whole key, not 3 separate 8-char windows.
    const key = "abcdefghij";
    const haystack = "xx abcdefghij xx";
    const result = findKeySubstrings(haystack, key, 8);
    expect(result).toEqual(["abcdefghij"]);
  });

  it("ignores 7-char matches when minLen is 8", () => {
    const key = "abcdefghij";
    const haystack = "xx abcdefg xx"; // 7-char substring of key
    const result = findKeySubstrings(haystack, key, 8);
    expect(result).toEqual([]);
  });
});

describe("runCisoGateG1", () => {
  it("PASSES against CleanProvider (no logging)", async () => {
    const provider = new CleanProvider({ apiKey: TEST_KEY });
    const result = await runCisoGateG1({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        await provider.complete({
          model: "synthetic/test",
          messages: [{ role: "user", content: "hello" }],
        });
      },
    });
    expect(result.gate).toBe("G-1-credential-redaction");
    expect(result.pass).toBe(true);
    expect(result.leakedSubstrings).toBeUndefined();
  });

  it("FAILS against LeakyProvider (logs key to stderr)", async () => {
    const provider = new LeakyProvider({
      apiKey: TEST_KEY,
      leakStdout: true,
      leakSpawn: false,
    });
    const result = await runCisoGateG1({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        await provider.complete({
          model: "synthetic/test",
          messages: [{ role: "user", content: "hello" }],
        });
      },
    });
    expect(result.pass).toBe(false);
    expect(result.leakedSubstrings).toBeDefined();
    expect(result.leakedSubstrings!.length).toBeGreaterThan(0);
    expect(result.leakedSubstrings![0]).toContain("sk-test-G1-");
  });

  it("returns FAIL when testKey is too short to evaluate", async () => {
    const result = await runCisoGateG1({
      testKey: "short",
      invokeProvider: async () => {},
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/shorter than/);
  });

  it("restores process.stdout.write and process.stderr.write after the run", async () => {
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;

    await runCisoGateG1({
      testKey: TEST_KEY,
      invokeProvider: async () => {},
    });

    expect(process.stdout.write).toBe(origStdout);
    expect(process.stderr.write).toBe(origStderr);
  });

  it("restores I/O interceptors even when invokeProvider throws", async () => {
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;

    const result = await runCisoGateG1({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        throw new Error("simulated provider failure");
      },
    });

    expect(process.stdout.write).toBe(origStdout);
    expect(process.stderr.write).toBe(origStderr);
    // Throwing during invoke does NOT itself fail the gate (gate is about redaction)
    expect(result.pass).toBe(true);
    expect(result.reason).toContain("invokeProvider threw");
  });

  it("PASSES even when provider emits unrelated output (only key substrings matter)", async () => {
    const result = await runCisoGateG1({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        process.stdout.write("Hello! Some debug info: model=anthropic/claude-sonnet-4\n");
        process.stderr.write("[info] connecting...\n");
      },
    });
    expect(result.pass).toBe(true);
  });

  it("FAILS when key appears in stdout (not just stderr)", async () => {
    const result = await runCisoGateG1({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        process.stdout.write(`my key is ${TEST_KEY}\n`);
      },
    });
    expect(result.pass).toBe(false);
  });

  it("times out a hung invokeProvider with a FAIL", async () => {
    const result = await runCisoGateG1({
      testKey: TEST_KEY,
      timeoutMs: 50,
      invokeProvider: () => new Promise((r) => setTimeout(r, 2000)),
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/timeout/i);
  }, 5000);

  it("returns promptly and restores stdout/stderr when invokeProvider NEVER settles [f-jrig-core-2]", async () => {
    const origStdoutWrite = process.stdout.write;
    const origStderrWrite = process.stderr.write;
    // Before the fix, the flag-based timeout never interrupted the await on a
    // never-settling provider: this test hung past its own timeout and the
    // stdout/stderr interceptors stayed installed forever.
    const result = await runCisoGateG1({
      testKey: TEST_KEY,
      timeoutMs: 50,
      invokeProvider: () => new Promise<void>(() => {}),
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/timeout/i);
    expect(process.stdout.write).toBe(origStdoutWrite);
    expect(process.stderr.write).toBe(origStderrWrite);
  }, 5000);
});
