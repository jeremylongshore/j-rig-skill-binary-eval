import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
