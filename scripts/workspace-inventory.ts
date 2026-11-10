import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Shared with Vitest so quality scanning cannot silently retain a root-only scope.
export const testScopes = [
  {
    glob: "packages/*/src/**/*.test.ts",
    pattern: /^packages\/[^/]+\/src\/(?:.*\/)?[^/]+\.test\.ts$/,
  },
  { glob: "tests/**/*.test.ts", pattern: /^tests\/(?:.*\/)?[^/]+\.test\.ts$/ },
  { glob: "scripts/**/*.test.ts", pattern: /^scripts\/(?:.*\/)?[^/]+\.test\.ts$/ },
];

export function workspaceFiles(root: string): string[] {
  return [
    ...new Set(
      execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
}

export function snapshot(root: string, files: string[]) {
  return files.map((path) => {
    if (
      path.split("/").some((part) => part === "..") ||
      resolve(root, path) !== join(resolve(root), path)
    ) {
      throw new Error(`Invalid inventory path: ${path}`);
    }
    let current = resolve(root);
    for (const part of path.split("/")) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink in inventory: ${path}`);
    }
    if (!lstatSync(current).isFile()) throw new Error(`Non-file in inventory: ${path}`);
    const bytes = readFileSync(current);
    return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
