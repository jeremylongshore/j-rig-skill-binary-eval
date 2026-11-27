import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { coverageInputs, sha256 } from "./workspace-coverage-contract.ts";
import { measureWorkspaceCrap } from "./workspace-crap.ts";

let root: string;
let provider: string;
const inventory = [
  { path: "packages/a/src/source.ts", kind: "src", sha256: "" },
  { path: "packages/a/src/source.test.ts", kind: "test", sha256: "" },
];
function write(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
function scope() {
  return {
    discovered_files: 1,
    scored_files: 1,
    type_only_files: 0,
    discovered_functions: 1,
    scored_functions: 1,
  };
}
function result() {
  return {
    schema_version: "crap-measurement/v1",
    complete: true,
    pass: true,
    scopes: { src: scope(), test: scope() },
    thresholds: { production_max: 30, test_max: 15, project_avg_max: 10 },
  };
}
function configure(report: unknown, exit = 0) {
  write(join(provider, "report.json"), JSON.stringify({ report, exit }));
}
function receipt(entries = inventory, complete = true) {
  write(
    join(root, "coverage/workspace/collection.json"),
    JSON.stringify({
      complete,
      inventory: entries,
      identity: coverageInputs(root, "vitest.config.ts", true),
      coverageSha256: sha256(readFileSync(join(root, "coverage/workspace/coverage-final.json"))),
    }),
  );
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jrig-strict-adapter-"));
  provider = join(root, "provider");
  execFileSync("git", ["init", "--quiet", root]);
  symlinkSync(join(import.meta.dirname, "../node_modules"), join(root, "node_modules"), "dir");
  write(join(root, "vitest.config.ts"), "export default { test: {} };\n");
  write(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  write(join(root, "packages/a/package.json"), '{"name":"fixture-a"}');
  write(join(root, inventory[0].path), "export function actual() { return 1; }\n");
  write(join(root, inventory[1].path), "it('actual result', () => expect(actual()).toBe(1));\n");
  for (const file of inventory) file.sha256 = sha256(readFileSync(join(root, file.path)));
  write(join(root, "coverage/workspace/coverage-final.json"), "{}\n");
  receipt();
  // A real subprocess fixture tests the protocol boundary; CI runs the immutable upstream provider.
  write(
    join(provider, "scripts/crap-score.py"),
    `import json, pathlib, sys
root = pathlib.Path(__file__).parent.parent
config = json.loads((root / 'report.json').read_text())
args = sys.argv[1:]
(root / 'argv.json').write_text(json.dumps(args))
out = pathlib.Path(args[args.index('--out') + 1])
(out / 'summary.json').write_text(json.dumps(config['report']))
raise SystemExit(config['exit'])
`,
  );
  write(join(provider, "scripts/crap_strict.py"), "# protocol fixture\n");
  write(join(provider, "scripts/crap_typescript.mjs"), "// protocol fixture\n");
  configure(result());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("refuses configuration-only drift without launching the scorer", () => {
  write(join(root, "vitest.config.ts"), "export default { test: { isolate: false } };\n");
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("inputs changed");
  expect(() => readFileSync(join(provider, "argv.json"))).toThrow();
});

it("refuses a receipt from older collector code without source/test changes", () => {
  const path = join(root, "coverage/workspace/collection.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.identity.collector.convert = "0".repeat(64);
  write(path, JSON.stringify(saved));
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("inputs changed");
  expect(() => readFileSync(join(provider, "argv.json"))).toThrow();
});

it("passes every literal current source/test path and retains provider identities", () => {
  expect(measureWorkspaceCrap(root, provider)).toMatchObject({ complete: true, pass: true });
  const args: string[] = JSON.parse(readFileSync(join(provider, "argv.json"), "utf8"));
  expect(args).toContain("--strict-measurement");
  expect(args.slice(args.indexOf("--source-glob"))).toEqual([
    "--source-glob",
    inventory[0].path,
    "--test-glob",
    inventory[1].path,
  ]);
  const saved = JSON.parse(readFileSync(join(root, "coverage/strict/provider.json"), "utf8"));
  expect(saved.identity).toHaveLength(3);
  expect(saved.identity[0]).toEqual({
    path: "scripts/crap-score.py",
    sha256: sha256(readFileSync(join(provider, "scripts/crap-score.py"))),
  });
});

it("retains a measured threshold failure as a failed verdict", () => {
  configure({ ...result(), pass: false }, 1);
  expect(measureWorkspaceCrap(root, provider)).toMatchObject({ complete: true, pass: false });
});

it("invalidates stale success and rejects incomplete collection before provider execution", () => {
  write(join(root, "coverage/strict/summary.json"), JSON.stringify(result()));
  receipt(inventory, false);
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("Coverage receipt is incomplete");
  expect(() => readFileSync(join(root, "coverage/strict/summary.json"))).toThrow();
  expect(() => readFileSync(join(provider, "argv.json"))).toThrow();
});

it("refuses omitted inventory, changed source bytes and changed coverage bytes", () => {
  receipt(inventory.slice(0, 1));
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("full current inventory");
  receipt();
  write(join(root, inventory[0].path), "export function changed() { return 2; }\n");
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("full current inventory");
  inventory[0].sha256 = sha256(readFileSync(join(root, inventory[0].path)));
  receipt();
  write(join(root, "coverage/workspace/coverage-final.json"), '{"changed":true}\n');
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("full current inventory");
});

it("refuses missing, crashing and malformed providers", () => {
  expect(() => measureWorkspaceCrap(root, join(root, "absent-provider"))).toThrow();
  configure(result(), 2);
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("Strict provider failed");
  configure(null);
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("measurement object");
});

it("refuses incomplete or zero-method success and exit/result disagreement", () => {
  configure({ ...result(), complete: false });
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("Strict provider failed");
  const empty = { ...scope(), discovered_functions: 0, scored_functions: 0 };
  configure({ ...result(), scopes: { src: empty, test: empty } });
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("omitted files or functions");
  configure(result(), 1);
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("disagreed with its exit");
});

it("refuses changed limits and incomplete function denominators", () => {
  configure({ ...result(), thresholds: { production_max: 31, test_max: 15, project_avg_max: 10 } });
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("30/15/10 limits");
  configure({
    ...result(),
    scopes: { src: { ...scope(), discovered_functions: 2 }, test: scope() },
  });
  expect(() => measureWorkspaceCrap(root, provider)).toThrow("omitted files or functions");
});
