/**
 * Real-disk {@link CodemodFs} implementation. Kept separate from the pure
 * codemod driver so the driver stays unit-testable against an in-memory fs.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CodemodFs } from "./codemod.js";

/** A {@link CodemodFs} backed by the Node filesystem. */
export const nodeFs: CodemodFs = {
  walk(dir: string): string[] {
    const out: string[] = [];
    walkInto(dir, out);
    return out.sort();
  },
  read(path: string): string {
    return readFileSync(path, "utf-8");
  },
  write(path: string, content: string): void {
    writeFileSync(path, content);
  },
};

function walkInto(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walkInto(full, out);
    } else {
      out.push(full);
    }
  }
}
