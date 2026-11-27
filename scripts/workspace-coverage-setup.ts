// Public Vitest setupFiles hook. Registered first and run last with hooks=stack.
import { afterAll, expect } from "vitest";
import { Session } from "node:inspector";
import type { Debugger, Profiler } from "node:inspector";
import { randomUUID } from "node:crypto";
import { threadId } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { resolve, relative } from "node:path";
import { readManifest, verifySources, writePrivate } from "./workspace-coverage-contract.ts";
import type { CapturedScript, FlushReceipt } from "./workspace-coverage-contract.ts";

const directory = process.env.JRIG_COVERAGE_STAGE;
if (!directory) throw new Error("Missing private coverage stage");
const { manifest, manifestHash } = readManifest(directory);
verifySources(manifest);
const testPath = relative(manifest.root, expect.getState().testPath || "");
if (!manifest.files.some((file) => file.kind === "test" && file.path === testPath)) {
  throw new Error("Test module is outside the declared coverage inventory");
}
const token = randomUUID();
const startedAt = Date.now();
const identity = {
  version: 1 as const,
  runId: manifest.runId,
  manifestHash,
  token,
  testPath,
  pid: process.pid,
  threadId,
  poolId: process.env.VITEST_POOL_ID || "",
  startedAt,
};
writePrivate(directory, `${token}.start.json`, identity);
const allowed = new Set(
  manifest.files.map((file) => pathToFileURL(resolve(manifest.root, file.path)).href),
);
const session = new Session();
session.connect();
function post(method: string, params = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => {
      if (error) reject(error);
      else resolve(result as Record<string, unknown>);
    }),
  );
}
const scripts = new Map<string, CapturedScript>();
const pending: Promise<void>[] = [];
const errors: string[] = [];
let closed = false;
session.on(
  "Debugger.scriptParsed",
  ({ params }: { params: Debugger.ScriptParsedEventDataType }) => {
    if (!allowed.has(params.url)) return;
    if (closed) {
      errors.push("Inventory script parsed after coverage flush");
      return;
    }
    const { scriptId, url, startLine, startColumn, executionContextId, hash, sourceMapURL } =
      params;
    pending.push(
      post("Debugger.getScriptSource", { scriptId })
        .then((result) => {
          if (typeof result.scriptSource !== "string")
            throw new Error("Missing captured script source");
          scripts.set(scriptId, {
            parsed: {
              scriptId,
              url,
              startLine,
              startColumn,
              executionContextId,
              hash,
              sourceMapURL,
            },
            source: result.scriptSource,
          });
        })
        .catch(() => {
          errors.push(`Script capture failed: ${url}`);
        }),
    );
  },
);
await post("Debugger.enable");
await post("Profiler.enable");
await post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
afterAll(async () => {
  try {
    // Drain script-source requests, including any appended while awaiting them.
    let count = -1;
    while (count !== pending.length) {
      count = pending.length;
      await Promise.all(pending);
    }
    const taken = await post("Profiler.takePreciseCoverage");
    closed = true;
    const coverage = (taken.result as Profiler.ScriptCoverage[]).filter((script) =>
      allowed.has(script.url),
    );
    for (const script of coverage)
      if (!scripts.has(script.scriptId)) errors.push(`Missing map receipt: ${script.url}`);
    verifySources(manifest);
    await post("Profiler.stopPreciseCoverage");
    await post("Debugger.disable");
    session.disconnect();
    const receipt: FlushReceipt = {
      ...identity,
      flushedAt: Date.now(),
      errors,
      scripts: [...scripts.values()].filter((script) =>
        coverage.some((row) => row.scriptId === script.parsed.scriptId),
      ),
      coverage,
    };
    writePrivate(directory, `${token}.flush.json`, receipt);
    if (errors.length) throw new Error("Coverage capture incomplete");
  } catch (error) {
    session.disconnect();
    throw error;
  }
}, 30_000);
