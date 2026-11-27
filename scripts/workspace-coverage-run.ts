import { defaultCoverageInventory } from "./workspace-coverage-inventory.ts";
import type { CoverageInventory } from "./workspace-coverage-inventory.ts";
import { noRuntimeSources } from "./workspace-coverage-types.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { snapshot } from "./workspace-inventory.ts";
import {
  CollectionError,
  coverageInputs,
  sha256,
  writePrivate,
} from "./workspace-coverage-contract.ts";
import type { CoverageManifest } from "./workspace-coverage-contract.ts";
import { reconcileCoverage } from "./workspace-coverage-convert.ts";

export interface CollectionOptions {
  root: string;
  configFile: string;
  inventory?: CoverageInventory;
  out: string;
  maxWorkers?: number;
  timeoutMs?: number;
  // Tests can retain private staging for deterministic corruption regressions.
  retainStage?: boolean;
}
export async function collectWorkspaceCoverage(options: CollectionOptions) {
  const root = resolve(options.root);
  const out = resolve(root, options.out);
  mkdirSync(out, { recursive: true });
  // Invalidate prior success before discovery or input validation can fail.
  rmSync(join(out, "coverage-final.json"), { force: true });
  rmSync(join(out, "collection.json"), { force: true });
  const manifest: CoverageManifest = { version: 1, runId: randomUUID(), root, files: [] };
  let directory: string | undefined;
  const identity: Record<string, unknown> = {};
  let noRuntimeExclusions: ReturnType<typeof noRuntimeSources> = [];
  const checked = new Map<string, string>();
  function bind(path: string) {
    const hash = sha256(readFileSync(path));
    checked.set(path, hash);
    return hash;
  }
  try {
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      throw new CollectionError("timeout-ms must be an integer from 1 through 3600000");
    }
    if (process.platform === "win32")
      throw new CollectionError("POSIX process groups required for bounded collection");
    const inventory = options.inventory ?? defaultCoverageInventory(root);
    const defaultInventory = options.inventory === undefined;
    if (!Array.isArray(inventory?.src) || !Array.isArray(inventory?.test)) {
      throw new CollectionError("Explicit src/test inventory arrays required");
    }
    const files = [...inventory.src, ...inventory.test];
    if (
      !inventory.test.length ||
      !files.length ||
      new Set(files).size !== files.length ||
      files.some(
        (file) =>
          typeof file !== "string" || !/\.(?:[cm]?ts|tsx)$/.test(file) || /[*?[\]{}!]/.test(file),
      )
    ) {
      throw new CollectionError(
        "Coverage inventory must contain unique literal TypeScript files and tests",
      );
    }
    const captured = snapshot(root, files);
    Object.assign(manifest, {
      version: 1,
      runId: randomUUID(),
      root,
      files: captured.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        kind: inventory.test.includes(file.path) ? "test" : "src",
      })),
    });
    directory = mkdtempSync(join(tmpdir(), "jrig-workspace-coverage-"));
    chmodSync(directory, 0o700);
    writePrivate(directory, "manifest.json", manifest);
    const scripts = dirname(fileURLToPath(import.meta.url));
    const caller = createRequire(join(root, "package.json"));
    const vitestPackage = caller.resolve("vitest/package.json");
    const config = join(directory, "vitest.config.mjs");
    const basePath = pathToFileURL(resolve(root, options.configFile)).href;
    // Compose public config only. Preserve the project's fixtures/plugins and
    // reporters, while using a separate collection lane with coverage disabled.
    writeFileSync(
      config,
      `import base from ${JSON.stringify(basePath)};
export default async (environment) => {
  const original = await (typeof base === 'function' ? base(environment) : base);
  const test = original.test || {};
  if (test.projects || test.workspace || test.browser?.enabled || test.isolate === false ||
      (test.sequence?.hooks && test.sequence.hooks !== 'stack')) throw new Error('Unsupported coverage lifecycle configuration');
  const setup = test.setupFiles ? [test.setupFiles].flat() : [];
  const reporters = test.reporters ? (Array.isArray(test.reporters) ? test.reporters : [test.reporters]) : ['default'];
  return {...original, root: ${JSON.stringify(root)}, test: {...test,
    include: ${JSON.stringify(inventory.test)}, exclude: [],
    setupFiles: [${JSON.stringify(join(scripts, "workspace-coverage-setup.ts"))}, ...setup],
    reporters: [...reporters, ${JSON.stringify(join(scripts, "workspace-coverage-reporter.ts"))}],
    pool: 'forks', isolate: true, minWorkers: 1, maxWorkers: ${options.maxWorkers || 2},
    sequence: {...test.sequence, hooks: 'stack', setupFiles: 'list'},
    coverage: {...test.coverage, enabled: false}, watch: false,
  }};
};\n`,
      { mode: 0o600 },
    );
    Object.assign(identity, coverageInputs(root, options.configFile, defaultInventory, bind));

    noRuntimeExclusions = noRuntimeSources(manifest);
    const exitCode = await new Promise<number | null>((done, reject) => {
      const child = spawn(
        process.execPath,
        [join(dirname(vitestPackage), "vitest.mjs"), "run", "--config", config],
        {
          cwd: root,
          detached: true,
          stdio: "inherit",
          env: { ...process.env, JRIG_COVERAGE_STAGE: directory, NODE_V8_COVERAGE: "" },
        },
      );
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch {
            /* already exited */
          }
        }
      };
      const timer = setTimeout(() => {
        signalGroup("SIGTERM");
        escalation = setTimeout(() => signalGroup("SIGKILL"), 1_000);
        deadline = setTimeout(() => done(null), 2_000);
      }, timeoutMs);
      const clear = () => {
        clearTimeout(timer);
        clearTimeout(escalation);
        clearTimeout(deadline);
      };
      child.on("error", (error) => {
        clear();
        signalGroup("SIGKILL");
        reject(error);
      });
      child.on("exit", (code) => {
        clear();
        signalGroup("SIGKILL");
        done(code);
      });
    });
    if (
      defaultInventory &&
      JSON.stringify(defaultCoverageInventory(root)) !== JSON.stringify(inventory)
    ) {
      throw new CollectionError("Default coverage inventory changed during measurement");
    }
    const result = await reconcileCoverage(directory, exitCode);
    if ([...checked].some(([path, expected]) => sha256(readFileSync(path)) !== expected)) {
      throw new CollectionError("Collector inputs changed during measurement");
    }
    const coverageBytes = JSON.stringify(result.coverage, null, 2) + "\n";
    writeFileSync(join(out, "coverage-final.json"), coverageBytes);
    const report = { ...result.report, identity, coverageSha256: sha256(coverageBytes) };
    writeFileSync(join(out, "collection.json"), JSON.stringify(report, null, 2) + "\n");
    return {
      complete: true as const,
      report,
      ...(options.retainStage ? { stage: directory } : {}),
    };
  } catch (error) {
    const report = {
      schemaVersion: "workspace-coverage/v1",
      complete: false,
      noRuntimeExclusions,
      counts: { requestedFiles: manifest.files.length, noRuntimeFiles: noRuntimeExclusions.length },
      runId: manifest.runId,
      inventory: manifest.files,
      identity,
      reasons: [
        error instanceof CollectionError
          ? error.message
          : "Collection infrastructure failed; no complete receipt",
      ],
    };
    writeFileSync(join(out, "collection.json"), JSON.stringify(report, null, 2) + "\n");
    return {
      complete: false as const,
      report,
      ...(options.retainStage ? { stage: directory } : {}),
    };
  } finally {
    if (directory && !options.retainStage) rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: "." },
      inventory: { type: "string" },
      "timeout-ms": { type: "string", default: "120000" },
      config: { type: "string", default: "vitest.config.ts" },
      out: { type: "string", default: "coverage/workspace" },
    },
  });
  // CLI parsing must also invalidate previous success before reading JSON.
  const cliOut = resolve(values.root!, values.out!);
  mkdirSync(cliOut, { recursive: true });
  rmSync(join(cliOut, "coverage-final.json"), { force: true });
  rmSync(join(cliOut, "collection.json"), { force: true });
  const inventory = values.inventory
    ? (JSON.parse(
        readFileSync(resolve(values.root!, values.inventory), "utf8"),
      ) as CoverageInventory)
    : undefined;
  const result = await collectWorkspaceCoverage({
    root: values.root!,
    configFile: values.config!,
    inventory,
    timeoutMs: Number(values["timeout-ms"]),
    out: values.out!,
  });
  console.log(
    JSON.stringify({ complete: result.complete, report: join(values.out!, "collection.json") }),
  );
  process.exitCode = result.complete ? 0 : 2;
}
