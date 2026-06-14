import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodeFs } from "./fs.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "j-rig-migrate-fs-"));
  created.push(dir);
  return dir;
}

describe("nodeFs", () => {
  it("walks a directory tree, skipping node_modules and .git", () => {
    const dir = scratch();
    writeFileSync(join(dir, "a.json"), "1");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.json"), "2");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "skip.json"), "3");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "skip.json"), "4");

    const walked = nodeFs.walk(dir).map((p) => p.slice(dir.length + 1));
    expect(walked).toContain("a.json");
    expect(walked).toContain(join("sub", "b.json"));
    expect(walked.some((p) => p.includes("node_modules"))).toBe(false);
    expect(walked.some((p) => p.includes(".git"))).toBe(false);
  });

  it("returns [] for a non-existent directory", () => {
    expect(nodeFs.walk(join(tmpdir(), "definitely-missing-xyz-123"))).toEqual([]);
  });

  it("round-trips read/write", () => {
    const dir = scratch();
    const path = join(dir, "x.json");
    nodeFs.write(path, "hello");
    expect(nodeFs.read(path)).toBe("hello");
  });
});
