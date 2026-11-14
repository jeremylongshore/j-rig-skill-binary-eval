import { describe, it, expect, afterEach } from "vitest";
import child_process from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it.each(["spawn", "exec", "execSync", "fork"] as const)(
    "inspects real %s children with explicit sanitized and leaking environments",
    async (method) => {
      const directory = mkdtempSync(join(tmpdir(), "g2-child-"));
      const script = join(directory, "child.cjs");
      writeFileSync(script, "process.exit(0);\n");
      try {
        for (const leaks of [false, true]) {
          const env = { G2_FIXTURE: leaks ? `prefix-${TEST_KEY}-suffix` : "harmless" };
          let childPid: number | undefined;
          let childCode: number | null = null;
          let childSignal: NodeJS.Signals | null = null;
          const result = await runCisoGateG2({
            testKey: TEST_KEY,
            invokeProvider: async () => {
              if (method === "execSync") {
                child_process.execSync(`"${process.execPath}" "${script}"`, {
                  env,
                  stdio: "ignore",
                });
                childCode = 0;
                return;
              }
              const child =
                method === "spawn"
                  ? child_process.spawn(process.execPath, [script], { env, stdio: "ignore" })
                  : method === "exec"
                    ? child_process.exec(`"${process.execPath}" "${script}"`, { env })
                    : child_process.fork(script, [], { env, execArgv: [], silent: true });
              childPid = child.pid;
              const [code, signal] = await once(child, "close");
              childCode = code;
              childSignal = signal;
            },
          });
          expect(result.pass).toBe(!leaks);
          expect(result.reason).not.toContain("invokeProvider threw");
          expect(childCode).toBe(0);
          if (method !== "execSync") {
            expect(childPid).toBeGreaterThan(0);
            expect(childSignal).toBeNull();
          }
          expect(result.spawnedPids).toEqual(method === "execSync" ? [] : [childPid]);
          if (leaks) {
            expect(result.perChildLeaks).toEqual([
              {
                pid: method === "execSync" ? -1 : childPid,
                command:
                  method === "spawn"
                    ? process.execPath
                    : method === "fork"
                      ? script
                      : `"${process.execPath}" "${script}"`,
                leakedEnvVars: ["G2_FIXTURE"],
                source: "spawn-hook",
              },
            ]);
            expect(JSON.stringify(result)).not.toContain(TEST_KEY);
          } else {
            expect(result.perChildLeaks).toBeUndefined();
            expect(result.reason).toBe(
              "1 subprocess(es) inspected; no test-key spillover detected",
            );
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("detects inherited synthetic environment and restores the parent's environment", async () => {
    const originalEnvironment = process.env;
    let result: Awaited<ReturnType<typeof runCisoGateG2>>;
    let childCode: number | null = null;
    try {
      process.env = { G2_INHERITED: TEST_KEY };
      result = await runCisoGateG2({
        testKey: TEST_KEY,
        invokeProvider: async () => {
          const child = child_process.spawn(process.execPath, ["-e", "process.exit(0)"]);
          const [code] = await once(child, "close");
          childCode = code;
        },
      });
    } finally {
      process.env = originalEnvironment;
    }
    expect(result.pass).toBe(false);
    expect(childCode).toBe(0);
    expect(result.perChildLeaks).toEqual([
      expect.objectContaining({ leakedEnvVars: ["G2_INHERITED"], source: "spawn-hook" }),
    ]);
    expect(result.reason).not.toContain("invokeProvider threw");
    expect(process.env).toBe(originalEnvironment);
  });

  it("keeps recorded spawn environments immutable when the caller sanitizes its object later", async () => {
    const env = { G2_SNAPSHOT: TEST_KEY };
    let childStatus: number | null = null;
    const result = await runCisoGateG2({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        const child = child_process.spawnSync(process.execPath, ["-e", "process.exit(0)"], {
          env,
          stdio: "ignore",
        });
        childStatus = child.status;
        env.G2_SNAPSHOT = "sanitized-after-spawn";
      },
    });
    expect(result.pass).toBe(false);
    expect(childStatus).toBe(0);
    expect(result.perChildLeaks?.[0]?.leakedEnvVars).toEqual(["G2_SNAPSHOT"]);
    expect(result.reason).not.toContain("invokeProvider threw");
  });

  it.runIf(process.platform === "linux")(
    "corroborates a live synthetic child leak through proc environ and cleans up the child",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "g2-live-child-"));
      const script = join(directory, "child.cjs");
      writeFileSync(script, "process.send('ready'); setInterval(() => {}, 1000);\n");
      let child: child_process.ChildProcess | undefined;
      let readyMessage: unknown;
      try {
        const result = await runCisoGateG2({
          testKey: TEST_KEY,
          invokeProvider: async () => {
            child = child_process.fork(script, {
              env: { G2_LIVE_FIXTURE: TEST_KEY },
              execArgv: [],
              silent: true,
            });
            const [message] = await once(child, "message");
            readyMessage = message;
          },
        });
        expect(child?.pid).toBeGreaterThan(0);
        expect(readyMessage).toBe("ready");
        expect(result.pass).toBe(false);
        expect(result.spawnedPids).toEqual([child?.pid]);
        expect(result.perChildLeaks).toEqual([
          {
            pid: child?.pid,
            command: script,
            leakedEnvVars: ["G2_LIVE_FIXTURE"],
            source: "spawn-hook",
          },
          {
            pid: child?.pid,
            command: script,
            leakedEnvVars: ["G2_LIVE_FIXTURE"],
            source: "proc-environ",
          },
        ]);
        expect(JSON.stringify(result)).not.toContain(TEST_KEY);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close");
          child.kill();
          await closed;
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([new Error("synchronous fixture failure"), "non-Error fixture failure"])(
    "restores hooks after synchronous invocation failure %s without inventing a leak",
    async (failure) => {
      const result = await runCisoGateG2({
        testKey: TEST_KEY,
        invokeProvider: () => {
          throw failure;
        },
      });
      expect(result.pass).toBe(true);
      expect(result.spawnedPids).toEqual([]);
      expect(result.reason).toContain(
        `invokeProvider threw '${failure instanceof Error ? failure.message : failure}'`,
      );
      expect(result.perChildLeaks).toBeUndefined();
    },
  );

  it("preserves detected leakage when the invocation subsequently fails", async () => {
    let childStatus: number | null = null;
    const result = await runCisoGateG2({
      testKey: TEST_KEY,
      invokeProvider: async () => {
        const child = child_process.spawnSync(process.execPath, ["-e", "process.exit(0)"], {
          env: { G2_BEFORE_FAILURE: TEST_KEY },
          stdio: "ignore",
        });
        childStatus = child.status;
        throw new Error("fixture failed after spawning");
      },
    });
    expect(result.pass).toBe(false);
    expect(childStatus).toBe(0);
    expect(result.perChildLeaks?.[0]?.leakedEnvVars).toEqual(["G2_BEFORE_FAILURE"]);
    expect(result.reason).toBe("1 subprocess(es) had the test key in their environment");
  });
});
