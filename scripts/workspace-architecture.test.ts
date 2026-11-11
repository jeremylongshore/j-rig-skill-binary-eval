import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { checkWorkspaceArchitecture } from "./workspace-architecture.js";

const roots: string[] = [];
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "jrig-architecture-"));
  roots.push(root);
  mkdirSync(join(root, "packages"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  return root;
}
function pkg(
  root: string,
  folder: string,
  name: string,
  source: string,
  manifest: Record<string, unknown> = {},
): void {
  const directory = join(root, "packages", folder);
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, ...manifest }));
  writeFileSync(join(directory, "src", "index.ts"), source);
}
function rules(root: string): string[] {
  return checkWorkspaceArchitecture(root).violations.map((v) => v.rule);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace architecture", () => {
  it("measures workspace source and barrel imports instead of an absent root src", () => {
    const root = workspace();
    pkg(root, "core", "@j-rig/core", "export const value = 1;");
    pkg(
      root,
      "cli",
      "@intentsolutions/jrig-cli",
      'import { value } from "@j-rig/core"; export { value };',
      { devDependencies: { "@j-rig/core": "workspace:*" } },
    );
    const report = checkWorkspaceArchitecture(root);
    expect(report).toMatchObject({
      result: "PASS",
      packages: 2,
      production_files: 2,
      import_edges: 1,
      violations: [],
    });
  });
  it("permits declared external subpaths and type-only workspace back-references", () => {
    const root = workspace();
    pkg(
      root,
      "core",
      "@j-rig/core",
      'import type { Shape } from "@intentsolutions/jrig-cli"; export type Thing = Shape;',
      { devDependencies: { "@intentsolutions/jrig-cli": "workspace:*" } },
    );
    pkg(
      root,
      "cli",
      "@intentsolutions/jrig-cli",
      'import { value } from "@j-rig/core"; import { parse } from "zod/v4"; export interface Shape {}',
      { dependencies: { "@j-rig/core": "workspace:*", zod: "4" } },
    );
    expect(rules(root)).toEqual([]);
  });
  it("refuses an undeclared dependency even when another package declares it", () => {
    const root = workspace();
    pkg(root, "a", "a", 'import { read } from "external/subpath";', {});
    pkg(root, "b", "b", "export const value = 1;", { dependencies: { external: "1" } });
    expect(rules(root)).toContain("undeclared-dependency");
  });
  it("rejects cross-package source paths instead of permitting bypass of public imports", () => {
    const root = workspace();
    pkg(root, "a", "a", 'export { value } from "../../b/src/index.js";', {
      dependencies: { b: "workspace:*" },
    });
    pkg(root, "b", "b", "export const value = 1;");
    expect(rules(root)).toContain("package-source-boundary");
  });
  it("rejects source imports from test and fixture modules", () => {
    const root = workspace();
    pkg(
      root,
      "a",
      "a",
      'import "./helper.test.js"; export { fake } from "./__fixtures__/fake.js";',
    );
    expect(rules(root).filter((r) => r === "production-imports-test")).toHaveLength(2);
  });
  it("does not apply production rules to the test corpus", () => {
    const root = workspace();
    pkg(root, "a", "a", "export const value = 1;");
    writeFileSync(join(root, "packages/a/src/unit.test.ts"), 'import "undeclared-test-helper";');
    expect(checkWorkspaceArchitecture(root)).toMatchObject({
      result: "PASS",
      production_files: 1,
      import_edges: 0,
    });
  });
  it("detects runtime cycles including re-exports and literal dynamic imports", () => {
    const root = workspace();
    pkg(root, "a", "a", 'export { value } from "b";', { dependencies: { b: "workspace:*" } });
    pkg(root, "b", "b", 'void import("a");', { dependencies: { a: "workspace:*" } });
    expect(rules(root)).toContain("workspace-runtime-cycle");
  });
  it("keeps the CLI a leaf even for a declared dependency", () => {
    const root = workspace();
    pkg(root, "core", "@j-rig/core", 'import "@intentsolutions/jrig-cli";', {
      dependencies: { "@intentsolutions/jrig-cli": "workspace:*" },
    });
    pkg(root, "cli", "@intentsolutions/jrig-cli", "export const cli = true;");
    expect(rules(root)).toContain("cli-is-leaf");
  });
  it.each([
    'import { readFile } from "node:fs/promises";',
    'export { request } from "https";',
    'void import("node:child_process");',
    'const fs = require("fs");',
    'fetch("https://example.invalid");',
    'globalThis.fetch("https://example.invalid");',
    'new WebSocket("wss://example.invalid");',
  ])("rejects direct I/O in refiner-core: %s", (source) => {
    const root = workspace();
    pkg(root, "refiner-core", "@intentsolutions/refiner-core", source);
    expect(rules(root)).toContain("refiner-core-no-io");
  });
  it("allows deterministic hashing and type-only Node I/O types", () => {
    const root = workspace();
    pkg(
      root,
      "refiner-core",
      "@intentsolutions/refiner-core",
      'import { createHash } from "node:crypto"; import type { Stats } from "node:fs"; export const hash = createHash("sha256");',
    );
    expect(rules(root)).toEqual([]);
  });
  it("blocks refiner-core depending on an I/O workspace package", () => {
    const root = workspace();
    pkg(root, "refiner-core", "@intentsolutions/refiner-core", 'import "@j-rig/db";', {
      dependencies: { "@j-rig/db": "workspace:*" },
    });
    pkg(root, "db", "@j-rig/db", "export const db = true;");
    expect(rules(root)).toContain("refiner-core-no-io");
  });
  it("fails closed on computed imports rather than missing their edge", () => {
    const root = workspace();
    pkg(root, "a", "a", "void import(process.env.MODULE!);");
    expect(rules(root)).toContain("unresolved-dynamic-import");
  });
  it.each([
    ['import { type Stats } from "node:fs";', 0],
    ['import defaultFs, { type Stats } from "node:fs";', 1],
    ['import { type Stats, readFile } from "node:fs";', 1],
    ['export { type Stats } from "node:fs";', 0],
    ['export type * from "node:fs";', 0],
    ['export {} from "node:fs";', 1],
    ['export { type Stats, readFile } from "node:fs";', 1],
    ['import type Fs = require("node:fs");', 0],
    ['import Fs = require("node:fs");', 1],
    ['type Stats = import("node:fs").Stats;', 0],
    ['import "node:fs";', 1],
    ["void import(`node:fs`);", 1],
  ])("preserves type-only versus runtime module references: %s", (source, ioCount) => {
    const root = workspace();
    pkg(root, "refiner-core", "@intentsolutions/refiner-core", source);
    const report = checkWorkspaceArchitecture(root);
    expect(report.import_edges).toBe(1);
    expect(report.violations).toEqual(
      Array.from({ length: ioCount }, () => ({
        file: "packages/refiner-core/src/index.ts",
        line: 1,
        rule: "refiner-core-no-io",
        detail: "node:fs",
      })),
    );
  });
  it("preserves preorder diagnostics while visiting children of unresolved imports", () => {
    const root = workspace();
    pkg(
      root,
      "refiner-core",
      "@intentsolutions/refiner-core",
      [
        'void import(globalThis.fetch("https://example.invalid"));',
        "require();",
        "new global.XMLHttpRequest();",
        'globalThis.WebSocket("wss://example.invalid");',
        "other.fetch();",
      ].join("\n"),
    );
    const report = checkWorkspaceArchitecture(root);
    expect(report).toEqual({
      schema_version: "workspace-architecture/v1",
      result: "FAIL",
      packages: 1,
      production_files: 1,
      import_edges: 0,
      placeholders: [],
      violations: [
        {
          line: 1,
          rule: "unresolved-dynamic-import",
          detail: "module specifier must be a literal for architecture verification",
        },
        { line: 1, rule: "refiner-core-no-io", detail: "fetch" },
        {
          line: 2,
          rule: "unresolved-dynamic-import",
          detail: "module specifier must be a literal for architecture verification",
        },
        { line: 3, rule: "refiner-core-no-io", detail: "XMLHttpRequest" },
        { line: 4, rule: "refiner-core-no-io", detail: "WebSocket" },
      ].map((violation) => ({ file: "packages/refiner-core/src/index.ts", ...violation })),
    });
  });
  it("refuses an empty workspace or new source-less package", () => {
    const root = workspace();
    expect(rules(root)).toContain("incomplete-inventory");
    pkg(root, "empty", "empty", "");
    rmSync(join(root, "packages/empty/src/index.ts"));
    expect(rules(root)).toContain("incomplete-inventory");
  });
  it("names the existing dashboard placeholder while measuring implemented packages", () => {
    const root = workspace();
    pkg(root, "a", "a", "export const value = 1;");
    mkdirSync(join(root, "packages/dashboard"));
    writeFileSync(
      join(root, "packages/dashboard/package.json"),
      JSON.stringify({ name: "@j-rig/dashboard" }),
    );
    expect(checkWorkspaceArchitecture(root)).toMatchObject({
      result: "PASS",
      production_files: 1,
      placeholders: ["@j-rig/dashboard"],
    });
  });
  it("rejects unsupported workspace layouts and malformed source", () => {
    const root = workspace();
    pkg(root, "a", "a", "export const = ;");
    expect(rules(root)).toContain("parse-error");
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n - "apps/*"\n');
    expect(rules(root)).toContain("incomplete-inventory");
  });
  it("rejects symlinked source roots instead of silently following outside the package", () => {
    const root = workspace();
    pkg(root, "a", "a", "export const value = 1;");
    pkg(root, "b", "b", "export const value = 1;");
    rmSync(join(root, "packages/a/src"), { recursive: true });
    symlinkSync(join(root, "packages/b/src"), join(root, "packages/a/src"));
    expect(rules(root)).toContain("incomplete-inventory");
  });
  it.each([
    { measured: false, status: 1, result: "FAIL", production_files: 0 },
    { measured: true, status: 0, result: "PASS", production_files: 1 },
  ])("returns $result and exit $status through the TypeScript CLI runner", (expected) => {
    const root = workspace();
    if (expected.measured) pkg(root, "a", "a", "export const value = 1;");
    const child = spawnSync(
      process.execPath,
      [
        createRequire(import.meta.url).resolve("tsx/cli"),
        resolve("scripts/workspace-architecture.ts"),
        root,
      ],
      { encoding: "utf8" },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(expected.status);
    expect(JSON.parse(child.stdout)).toMatchObject({
      result: expected.result,
      production_files: expected.production_files,
    });
  });
});
