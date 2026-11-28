import { defaultCoverageInventory } from "./workspace-coverage-inventory.ts";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWorkspaceCoverage } from "./workspace-coverage-run.ts";
import { isTypeOnlySource } from "./workspace-coverage-types.ts";
import { reconcileCoverage } from "./workspace-coverage-convert.ts";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "jrig-collector-test-"));
  temporary.push(path);
  return path;
}

function fixture(interrupt = false) {
  const root = directory();
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(
    join(root, "vitest.config.mjs"),
    "export default {test:{testTimeout:10000,hookTimeout:10000,setupFiles:['./project-setup.ts']}};\n",
  );
  writeFileSync(
    join(root, "source.ts"),
    `export function live(x: number) { return x ? 1 : 2; }
export function neverCalled() { return 99; }
export function teardown() { return 3; }
export function setupStart() { return 4; }
export function setupEnd() { return 5; }\n`,
  );
  writeFileSync(
    join(root, "project-setup.ts"),
    `
import { beforeAll, afterAll, expect } from 'vitest';
import { setupStart, setupEnd } from './source';
beforeAll(() => { expect(setupStart()).toBe(4); });
afterAll(() => { expect(setupEnd()).toBe(5); });
`,
  );
  writeFileSync(
    join(root, "types.ts"),
    `import type { live } from './source';
export interface Shape { run: typeof live; }
export type Callback = () => number;
export type { Shape as OtherShape };
`,
  );
  for (const name of ["first", "second"])
    writeFileSync(
      join(root, `${name}.test.ts`),
      `
import { it, expect, afterAll } from 'vitest';
import { live, teardown } from './source';
it('runs ${name}', async () => {
  ${interrupt ? 'process.kill(process.pid, "SIGKILL");' : ""}
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(live(1)).toBe(1);
});
it.skip('retains zero execution', () => { expect(false).toBe(true); });
afterAll(() => { expect(teardown()).toBe(3); });
`,
    );
  return root;
}
const inventory = { src: ["source.ts", "types.ts"], test: ["first.test.ts", "second.test.ts"] };
let root: string;
let stage: string;
let report: Awaited<ReturnType<typeof collectWorkspaceCoverage>>;
function alteredStage(change: (directory: string) => void) {
  const copy = directory();
  cpSync(stage, copy, { recursive: true });
  change(copy);
  return copy;
}
function editFlush(path: string, change: (receipt: Record<string, unknown>) => void) {
  const name = readdirSync(path).find((name) => name.endsWith(".flush.json"))!;
  const file = join(path, name);
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  change(receipt);
  writeFileSync(file, JSON.stringify(receipt));
}

beforeAll(async () => {
  root = fixture();
  report = await collectWorkspaceCoverage({
    root,
    configFile: "vitest.config.mjs",
    inventory,
    out: "output",
    retainStage: true,
    maxWorkers: 2,
  });
  if (!report.complete) throw new Error(JSON.stringify(report.report));
  stage = report.stage!;
  temporary.push(stage);
}, 60_000);
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

describe("supported workspace coverage collection", () => {
  it("accounts for two workers, test callbacks, teardown, and uncalled functions", () => {
    expect(report.complete).toBe(true);
    if (!report.complete) return;
    expect(new Set(report.report.evidence.map((entry) => entry.pid)).size).toBe(2);
    expect(new Set(report.report.evidence.map((entry) => entry.path))).toEqual(
      new Set(["source.ts", ...inventory.test]),
    );
    expect(report.report.inventory).toHaveLength(4);
    expect(report.report.noRuntimeExclusions).toEqual([
      expect.objectContaining({ path: "types.ts", kind: "src", sha256: expect.any(String) }),
    ]);
    expect(report.report.counts).toEqual({
      requestedFiles: 4,
      observedFiles: 3,
      noRuntimeFiles: 1,
    });
    expect(statSync(stage).mode & 0o777).toBe(0o700);
    const data = JSON.parse(readFileSync(join(root, "output/coverage-final.json"), "utf8"));
    expect(data[join(root, "types.ts")]).toBeUndefined();
    const source = data[join(root, "source.ts")];
    const functions = Object.entries(source.fnMap) as [string, { name: string }][];
    expect(source.f[functions.find(([, fn]) => fn.name === "neverCalled")![0]]).toBe(0);
    expect(source.f[functions.find(([, fn]) => fn.name === "teardown")![0]]).toBe(2);
    for (const name of ["setupStart", "setupEnd"]) {
      expect(source.f[functions.find(([, fn]) => fn.name === name)![0]]).toBe(2);
    }
    for (const test of inventory.test) {
      const file = data[join(root, test)];
      expect(Object.values(file.f)).toContain(0);
    }
    const publicReport = readFileSync(join(root, "output/collection.json"), "utf8");
    expect(publicReport).not.toContain("scriptSource");
    expect(publicReport).not.toContain("sourcesContent");
    expect(publicReport).not.toContain("sourceMappingURL");
  });

  it("exempts only proven type statements, never runtime or mixed modules", () => {
    for (const text of [
      "export interface X { n: number }",
      "export type X = () => void;",
      "import type { X } from './x'; export type { X };",
      "// empty module\n",
    ]) {
      expect(isTypeOnlySource("types.ts", Buffer.from(text))).toBe(true);
    }
    for (const text of [
      "import './side-effects';",
      "export * from './source';",
      "export {};",
      "export const x = 1;",
      "export function x() {}",
      "export class X {}",
      "export enum X { A }",
      "namespace X { export const x = 1; }",
      "export interface X {}; export const x = 1;",
      "import { X } from './x'; export type Y = X;",
      "declare const x: number;",
    ]) {
      expect(isTypeOnlySource("types.ts", Buffer.from(text))).toBe(false);
    }
    expect(() => isTypeOnlySource("broken.ts", Buffer.from("export type X = ;"))).toThrow(
      "TypeScript syntax invalid",
    );
  });
  it("rejects invalid timeouts before launching a process", async () => {
    for (const timeoutMs of [0, -1, 1.5, Infinity, NaN, 3_600_001]) {
      const result = await collectWorkspaceCoverage({
        root,
        configFile: "vitest.config.mjs",
        inventory,
        out: "invalid-timeout",
        timeoutMs,
      });
      expect(result.complete).toBe(false);
      if (!result.complete)
        expect(result.report.reasons).toEqual([
          "timeout-ms must be an integer from 1 through 3600000",
        ]);
    }
  });
  it("rejects a missing flush rather than accepting remaining workers", async () => {
    const copy = alteredStage((path) =>
      rmSync(
        join(
          path,
          readdirSync(path).find((name) => name.endsWith(".flush.json"))!,
        ),
      ),
    );
    await expect(reconcileCoverage(copy, 0)).rejects.toThrow("Missing worker flush");
  });
  it("rejects missing map receipts", async () => {
    const copy = alteredStage((path) =>
      editFlush(path, (receipt) => {
        receipt.scripts = [];
      }),
    );
    await expect(reconcileCoverage(copy, 0)).rejects.toThrow("Missing script/map capture");
  });
  it("rejects missing inline maps", async () => {
    const copy = alteredStage((path) =>
      editFlush(path, (receipt) => {
        const scripts = receipt.scripts as { parsed: Record<string, unknown> }[];
        delete scripts[0].parsed.sourceMapURL;
      }),
    );
    await expect(reconcileCoverage(copy, 0)).rejects.toThrow("Missing inline source map");
  });
  it("rejects changed inline-map receipts", async () => {
    const copy = alteredStage((path) =>
      editFlush(path, (receipt) => {
        const scripts = receipt.scripts as { parsed: Record<string, unknown> }[];
        scripts[0].parsed.sourceMapURL = "data:application/json;base64,e30=";
      }),
    );
    await expect(reconcileCoverage(copy, 0)).rejects.toThrow("Changed map receipt");
  });
  it("rejects changed source-map content even with matching inline map", async () => {
    const copy = alteredStage((path) =>
      editFlush(path, (receipt) => {
        const script = (
          receipt.scripts as { parsed: { sourceMapURL: string }; source: string }[]
        )[0];
        const original = script.parsed.sourceMapURL;
        const map = JSON.parse(Buffer.from(original.split(",")[1], "base64").toString());
        map.sourcesContent[0] += "\n// changed\n";
        script.parsed.sourceMapURL =
          "data:application/json;base64," + Buffer.from(JSON.stringify(map)).toString("base64");
        script.source = script.source.replace(original, script.parsed.sourceMapURL);
      }),
    );
    await expect(reconcileCoverage(copy, 0)).rejects.toThrow("Source-map bytes differ");
  });
  it("rejects maps observed after the lifecycle flush", async () => {
    const copy = alteredStage((path) =>
      editFlush(path, (receipt) => {
        receipt.errors = ["Inventory script parsed after coverage flush"];
      }),
    );
    await expect(reconcileCoverage(copy, 0)).rejects.toThrow("Invalid or late worker flush");
  });
  it("rejects a flush later than reporter completion", async () => {
    const copy = alteredStage((path) =>
      editFlush(path, (receipt) => {
        receipt.flushedAt = Date.now() + 60_000;
      }),
    );
    await expect(reconcileCoverage(copy, 0)).rejects.toThrow("Invalid or late worker flush");
  });
  it("rejects changed source bytes", async () => {
    const file = join(root, "source.ts"),
      original = readFileSync(file);
    try {
      writeFileSync(file, original.toString() + "\n//changed");
      await expect(reconcileCoverage(stage, 0)).rejects.toThrow("Source changed");
    } finally {
      writeFileSync(file, original);
    }
  });
  it("rejects an invented wrapper displacement", async () => {
    const copy = alteredStage((path) =>
      editFlush(path, (receipt) => {
        (receipt.scripts as { parsed: { startColumn: number } }[])[0].parsed.startColumn--;
      }),
    );
    await expect(reconcileCoverage(copy, 0)).rejects.toThrow("Unverified execution wrapper");
  });
  it("reports an interrupted worker without a coverage artifact", async () => {
    const interrupted = fixture(true);
    const result = await collectWorkspaceCoverage({
      root: interrupted,
      configFile: "vitest.config.mjs",
      inventory,
      out: "output",
      maxWorkers: 2,
    });
    expect(result.complete).toBe(false);
    expect(readdirSync(join(interrupted, "output"))).toEqual(["collection.json"]);
  }, 60_000);
  it("bounds a hung run even when termination is ignored", async () => {
    const hung = fixture();
    writeFileSync(
      join(hung, "vitest.config.mjs"),
      `process.on('SIGTERM', () => {});
export default {test:{testTimeout:60000,hookTimeout:60000}};`,
    );
    writeFileSync(
      join(hung, "first.test.ts"),
      `import {it} from 'vitest';
process.on('SIGTERM', () => {});
it('hangs', async () => { await new Promise(() => {}); });`,
    );
    const start = Date.now();
    const result = await collectWorkspaceCoverage({
      root: hung,
      configFile: "vitest.config.mjs",
      inventory: { src: ["source.ts"], test: ["first.test.ts"] },
      out: "output",
      timeoutMs: 1500,
    });
    expect(result.complete).toBe(false);
    expect(Date.now() - start).toBeLessThan(8000);
    expect(readdirSync(join(hung, "output"))).toEqual(["collection.json"]);
  }, 15_000);
  it("reports unobserved declared production files without synthesizing coverage", async () => {
    const missing = fixture();
    writeFileSync(join(missing, "unloaded.ts"), "export function unloaded() { return 1; }\n");
    writeFileSync(
      join(missing, "mixed.ts"),
      "export interface Shape {}\nexport const value = 1;\n",
    );
    writeFileSync(join(missing, "no-functions.ts"), "export const value = 1;\n");
    const result = await collectWorkspaceCoverage({
      root: missing,
      configFile: "vitest.config.mjs",
      inventory: {
        ...inventory,
        src: [...inventory.src, "unloaded.ts", "mixed.ts", "no-functions.ts"],
      },
      out: "output",
    });
    expect(result.complete).toBe(false);
    expect(result.report.noRuntimeExclusions).toEqual([
      expect.objectContaining({ path: "types.ts" }),
    ]);
    if (!result.complete)
      expect(result.report.reasons[0]).toContain(
        "Unobserved inventory files: unloaded.ts, mixed.ts, no-functions.ts",
      );
    expect(readdirSync(join(missing, "output"))).toEqual(["collection.json"]);
  }, 60_000);
});

function defaultRepository() {
  const root = directory();
  execFileSync("git", ["init", "-q"], { cwd: root });
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  function write(path: string, contents: string) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  write(".gitignore", "node_modules/\noutput/\n");
  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write("package.json", '{"private":true,"type":"module"}');
  write("packages/a/package.json", '{"name":"@fixture/a"}');
  write("packages/dashboard/package.json", '{"name":"@j-rig/dashboard"}');
  write("packages/a/src/main.ts", "export function value() { return 1; }\n");
  write(
    "packages/a/src/main.test.ts",
    `import {it,expect} from 'vitest';
import {value} from './main'; it('colocated',()=>expect(value()).toBe(1));`,
  );
  write(
    "tests/root.test.ts",
    `import {it,expect} from 'vitest';
import {value} from '../packages/a/src/main'; it('root',()=>expect(value()).toBe(1));`,
  );
  write(
    "scripts/tool.test.ts",
    `import {it,expect} from 'vitest';
import {value} from '../packages/a/src/main'; it('tool',()=>expect(value()).toBe(1));`,
  );
  write("packages/a/src/ignored.spec.ts", "// outside the configured Vitest test scopes");
  write("packages/a/src/ambient.d.ts", "declare const value: number;");
  write("packages/a/src/__fixtures__/server.mjs", "console.log('fixture')");
  write("packages/a/tsup.config.ts", "export default {};");
  write("vitest.config.mjs", "export default {test:{}};");
  return { root, write };
}

describe("repository-default coverage inventory", () => {
  it("shares test scopes, excludes architecture non-production files and discovers new packages", () => {
    const { root, write } = defaultRepository();
    expect(defaultCoverageInventory(root)).toEqual({
      src: ["packages/a/src/main.ts"],
      test: ["packages/a/src/main.test.ts", "scripts/tool.test.ts", "tests/root.test.ts"],
    });
    write("packages/b/package.json", '{"name":"@fixture/b"}');
    write("packages/b/src/module.mts", "export const value = 2;");
    expect(defaultCoverageInventory(root).src).toEqual([
      "packages/a/src/main.ts",
      "packages/b/src/module.mts",
    ]);
  });
  it("rejects unsupported workspace layouts and production locations", () => {
    const { root, write } = defaultRepository();
    write("packages/a/lib/hidden.ts", "export const hidden = 1;");
    expect(() => defaultCoverageInventory(root)).toThrow("Unsupported production location");
    rmSync(join(root, "packages/a/lib"), { recursive: true });
    write("pnpm-workspace.yaml", 'packages:\n  - "modules/*"\n');
    expect(() => defaultCoverageInventory(root)).toThrow("Unsupported coverage workspace layout");
  });
  it("rejects unsupported extensions and ignored production files", () => {
    const { root, write } = defaultRepository();
    write("packages/a/src/hidden.js", "export const hidden = 1;");
    expect(() => defaultCoverageInventory(root)).toThrow("Unsupported production extension");
    rmSync(join(root, "packages/a/src/hidden.js"));
    write(".gitignore", "node_modules/\nhidden.ts\n");
    write("packages/a/src/hidden.ts", "export const hidden = 1;");
    expect(() => defaultCoverageInventory(root)).toThrow(
      "Production file omitted by Git inventory",
    );
  });
  it.each([
    "packages/a/src/hidden.test.ts",
    "tests/nested/hidden.test.ts",
    "scripts/nested/hidden.test.ts",
  ])("rejects ignored matching test %s", (path) => {
    const { root, write } = defaultRepository();
    write(".gitignore", "node_modules/\nhidden.test.ts\n");
    write(path, "import {it} from 'vitest';it('hidden',()=>{});");
    expect(() => defaultCoverageInventory(root)).toThrow(
      `Test file omitted by Git inventory: ${path}`,
    );
  });
  it("rejects source symlinks and deleted tracked production", () => {
    const { root } = defaultRepository();
    symlinkSync(join(root, "packages/a/src/main.ts"), join(root, "packages/a/src/linked.ts"));
    expect(() => defaultCoverageInventory(root)).toThrow("Symlink in production inventory");
    rmSync(join(root, "packages/a/src/linked.ts"));
    execFileSync("git", ["add", "packages/a/src/main.ts"], { cwd: root });
    rmSync(join(root, "packages/a/src/main.ts"));
    expect(() => defaultCoverageInventory(root)).toThrow("Empty production inventory");
  });
  it("collects without an external inventory and binds default policy identity", async () => {
    const { root } = defaultRepository();
    const result = await collectWorkspaceCoverage({
      root,
      configFile: "vitest.config.mjs",
      out: "output",
    });
    expect(result.complete, JSON.stringify(result.report)).toBe(true);
    expect(result.report.identity.inventoryMode).toBe("repository-default/v1");
    expect(result.report.identity.workspaceLayoutSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.report.inventory).toHaveLength(4);
  }, 60_000);
  it("invalidates prior coverage when default discovery fails", async () => {
    const { root, write } = defaultRepository();
    write("output/coverage-final.json", '{"stale":true}');
    write("output/collection.json", '{"complete":true}');
    write(".gitignore", "node_modules/\noutput/\nhidden.test.ts\n");
    write("tests/hidden.test.ts", "// ignored test");
    const result = await collectWorkspaceCoverage({
      root,
      configFile: "vitest.config.mjs",
      out: "output",
    });
    expect(result.complete).toBe(false);
    expect(readdirSync(join(root, "output"))).toEqual(["collection.json"]);
    expect(JSON.parse(readFileSync(join(root, "output/collection.json"), "utf8")).complete).toBe(
      false,
    );
  });
  it("rejects default membership changes during collection", async () => {
    const { root, write } = defaultRepository();
    write(
      "packages/a/src/main.test.ts",
      `import {it} from 'vitest';import {writeFileSync} from 'node:fs';
import {value} from './main';it('changes scope',()=>{value();writeFileSync('packages/a/src/late.ts','export const late = 1;');});`,
    );
    const result = await collectWorkspaceCoverage({
      root,
      configFile: "vitest.config.mjs",
      out: "output",
    });
    expect(result.complete).toBe(false);
    if (!result.complete)
      expect(result.report.reasons).toContain(
        "Default coverage inventory changed during measurement",
      );
    expect(readdirSync(join(root, "output"))).toEqual(["collection.json"]);
  }, 60_000);
});
