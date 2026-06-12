import { describe, it, expect, afterEach } from "vitest";
import child_process from "node:child_process";
import { runCisoGateG2 } from "./g2-env-var-spillover.js";
import { CleanProvider } from "../test-fixtures/clean-provider.js";
import { LeakyProvider } from "../test-fixtures/leaky-provider.js";

const TEST_KEY = "sk-test-G2-aaaa1111bbbb2222cccc3333dddd4444";

describe("runCisoGateG2", () => {
  // Snapshot the originals so a misbehaving runner can't leak into other tests
  const origSpawn = child_process.spawn;
  const origSpawnSync = child_process.spawnSync;
  const origExec = child_process.exec;
  const origExecSync = child_process.execSync;
  const origFork = child_process.fork;

  afterEach(() => {
    expect(child_process.spawn).toBe(origSpawn);
    expect(child_process.spawnSync).toBe(origSpawnSync);
    expect(child_process.exec).toBe(origExec);
    expect(child_process.execSync).toBe(origExecSync);
    expect(child_process.fork).toBe(origFork);
  });

  it("PASSES against CleanProvider (no subprocess spawn)", async () => {
    const provider = new CleanProvider({ apiKey: TEST_KEY });
    const result = await runCisoGateG2({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        await provider.complete({
          model: "synthetic/test",
          messages: [{ role: "user", content: "hello" }],
        });
      },
    });
    expect(result.gate).toBe("G-2-env-var-spillover");
    expect(result.pass).toBe(true);
    expect(result.spawnedPids).toEqual([]);
  });

  it("FAILS against LeakyProvider (spawns with key in env)", async () => {
    const provider = new LeakyProvider({
      apiKey: TEST_KEY,
      leakStdout: false,
      leakSpawn: true,
    });
    const result = await runCisoGateG2({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        await provider.complete({
          model: "synthetic/test",
          messages: [{ role: "user", content: "hello" }],
        });
      },
    });
    expect(result.pass).toBe(false);
    expect(result.perChildLeaks).toBeDefined();
    expect(result.perChildLeaks!.length).toBeGreaterThan(0);
    expect(result.perChildLeaks![0].leakedEnvVars).toContain("LEAKY_API_KEY");
  });

  it("inspects env even for spawn variants (spawnSync)", async () => {
    const result = await runCisoGateG2({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        child_process.spawnSync("node", ["-e", "process.exit(0)"], {
          env: { LEAK_VAR: TEST_KEY },
          stdio: "ignore",
        });
      },
    });
    expect(result.pass).toBe(false);
    expect(result.perChildLeaks![0].leakedEnvVars).toContain("LEAK_VAR");
  });

  it("PASSES when adapter spawns subprocess with sanitized env (key NOT passed)", async () => {
    const result = await runCisoGateG2({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        child_process.spawnSync("node", ["-e", "process.exit(0)"], {
          env: { SOME_OTHER_VAR: "harmless" },
          stdio: "ignore",
        });
      },
    });
    expect(result.pass).toBe(true);
  });

  it("returns FAIL when testKey is too short", async () => {
    const result = await runCisoGateG2({
      testKey: "short",
      invokeProvider: async () => {},
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/shorter than/);
  });

  it("times out a hung invokeProvider with a FAIL", async () => {
    const result = await runCisoGateG2({
      testKey: TEST_KEY,
      timeoutMs: 50,
      invokeProvider: () => new Promise((r) => setTimeout(r, 2000)),
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/timeout/i);
  }, 5000);

  it("returns promptly and restores child_process when invokeProvider NEVER settles [f-jrig-core-2]", async () => {
    // Before the fix, the flag-based timeout never interrupted the await on a
    // never-settling provider: this test hung past its own timeout and the
    // child_process hooks stayed installed forever (afterEach asserts the
    // originals are restored).
    const result = await runCisoGateG2({
      testKey: TEST_KEY,
      timeoutMs: 50,
      invokeProvider: () => new Promise<void>(() => {}),
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/timeout/i);
    expect(child_process.spawn).toBe(origSpawn);
  }, 5000);

  it("invokeProvider throwing does NOT itself fail the gate", async () => {
    const result = await runCisoGateG2({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        throw new Error("simulated provider failure");
      },
    });
    // Gate is about spillover, not about whether invoke succeeded.
    // No spawn happened → no spillover → PASS.
    expect(result.pass).toBe(true);
    expect(result.reason).toContain("invokeProvider threw");
  });
});
