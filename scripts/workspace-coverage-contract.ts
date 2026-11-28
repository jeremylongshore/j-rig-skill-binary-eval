import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Debugger, Profiler } from "node:inspector";
import { snapshot } from "./workspace-inventory.ts";

export interface InventoryEntry {
  path: string;
  kind: "src" | "test";
  sha256: string;
}
export interface CoverageManifest {
  version: 1;
  runId: string;
  root: string;
  files: InventoryEntry[];
}
export interface CapturedScript {
  parsed: Pick<
    Debugger.ScriptParsedEventDataType,
    | "scriptId"
    | "url"
    | "startLine"
    | "startColumn"
    | "executionContextId"
    | "hash"
    | "sourceMapURL"
  >;
  source: string;
}
export interface FlushReceipt {
  version: 1;
  runId: string;
  manifestHash: string;
  token: string;
  testPath: string;
  pid: number;
  threadId: number;
  poolId: string;
  startedAt: number;
  flushedAt: number;
  errors: string[];
  scripts: CapturedScript[];
  coverage: Profiler.ScriptCoverage[];
}
export interface ReporterReceipt {
  runId: string;
  manifestHash: string;
  reason: string;
  errors: number;
  modules: { path: string; state: string; endedAt: number }[];
}
export class CollectionError extends Error {}

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Explicit CI compatibility toolchain; never selected from a coverage receipt. */
export function vitestProvider(root: string) {
  const configured = process.env.JRIG_VITEST_PROVIDER_ROOT;
  if (configured !== undefined && (!configured || configured !== configured.trim())) {
    throw new CollectionError("Invalid explicit Vitest provider root");
  }
  const context = resolve(configured ?? root);
  const caller = createRequire(join(context, "package.json"));
  return {
    caller,
    context,
    explicit: configured !== undefined,
    packagePath: caller.resolve("vitest/package.json"),
  };
}

/** The same current inputs are bound at collection and checked again before scoring. */
export function coverageInputs(
  root: string,
  configFile: string,
  defaultInventory: boolean,
  bind = (path: string) => sha256(readFileSync(path)),
) {
  const scripts = dirname(fileURLToPath(import.meta.url));
  const selected = vitestProvider(root);
  const vitestPackage = selected.packagePath;
  const compatibility = selected.explicit
    ? {
        packageSha256: bind(join(selected.context, "package.json")),
        lockSha256: bind(
          join(
            selected.context,
            existsSync(join(selected.context, "package-lock.json"))
              ? "package-lock.json"
              : "pnpm-lock.yaml",
          ),
        ),
        runnerSha256: bind(join(dirname(vitestPackage), "vitest.mjs")),
      }
    : undefined;
  const providerRequire = createRequire(import.meta.url);
  const providers = Object.fromEntries(
    ["ast-v8-to-istanbul", "istanbul-lib-coverage", "vite", "typescript"].map((name) => {
      const entry = providerRequire.resolve(name);
      let folder = dirname(entry);
      while (!existsSync(join(folder, "package.json"))) {
        const parent = dirname(folder);
        if (parent === folder) throw new CollectionError("Missing provider package identity");
        folder = parent;
      }
      const packagePath = join(folder, "package.json");
      const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
      return [
        name,
        {
          version: metadata.version as string,
          entrySha256: bind(entry),
          packageSha256: bind(packagePath),
        },
      ];
    }),
  );
  return {
    nodeVersion: process.version,
    nodeSha256: bind(process.execPath),
    vitestVersion: JSON.parse(readFileSync(vitestPackage, "utf8")).version as string,
    vitestPackageSha256: bind(vitestPackage),
    ...(compatibility ? { compatibilityProvider: compatibility } : {}),
    configSha256: bind(resolve(root, configFile)),
    inventorySupportSha256: bind(join(scripts, "workspace-inventory.ts")),
    inventoryMode: defaultInventory ? "repository-default/v1" : "explicit",
    ...(defaultInventory ? { workspaceLayoutSha256: bind(join(root, "pnpm-workspace.yaml")) } : {}),
    ...(existsSync(join(root, "pnpm-lock.yaml"))
      ? { lockSha256: bind(join(root, "pnpm-lock.yaml")) }
      : {}),
    providers,
    collector: Object.fromEntries(
      ["contract", "setup", "reporter", "convert", "run", "types", "inventory"].map((name) => [
        name,
        bind(join(scripts, `workspace-coverage-${name}.ts`)),
      ]),
    ),
  };
}
export function writePrivate(directory: string, name: string, value: unknown) {
  const destination = join(directory, name);
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, destination);
}
export function readManifest(directory: string): {
  manifest: CoverageManifest;
  manifestHash: string;
} {
  const bytes = readFileSync(join(directory, "manifest.json"));
  return {
    manifest: JSON.parse(bytes.toString()) as CoverageManifest,
    manifestHash: sha256(bytes),
  };
}
export function verifySources(manifest: CoverageManifest) {
  const current = snapshot(
    manifest.root,
    manifest.files.map((file) => file.path),
  );
  for (const [index, file] of current.entries()) {
    if (file.sha256 !== manifest.files[index].sha256)
      throw new CollectionError(`Source changed: ${file.path}`);
  }
}
