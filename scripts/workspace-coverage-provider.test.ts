import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { collectWorkspaceCoverage } from "./workspace-coverage-run.ts";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const installedProvider = process.env.JRIG_VITEST_PROVIDER_ROOT ?? repository;
const temporary: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "jrig-provider-binding-"));
  temporary.push(root);
  return root;
}
function fixture(mutateLock = false) {
  const provider = directory();
  symlinkSync(join(installedProvider, "node_modules"), join(provider, "node_modules"), "dir");
  writeFileSync(join(provider, "package.json"), '{"private":true}\n');
  const lock = join(provider, "package-lock.json");
  writeFileSync(lock, '{"lockfileVersion":3}\n');
  const root = directory();
  symlinkSync(join(installedProvider, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  writeFileSync(join(root, "vitest.config.mjs"), "export default {test:{}};\n");
  writeFileSync(join(root, "source.ts"), "export function run() { return 2; }\n");
  writeFileSync(
    join(root, "source.test.ts"),
    `import {it,expect} from 'vitest'; import {writeFileSync} from 'node:fs';
import {run} from './source'; it('executes actual source',()=>{ expect(run()).toBe(2);
${mutateLock ? `writeFileSync(${JSON.stringify(lock)}, '{"tampered":true}');` : ""}
});\n`,
  );
  mkdirSync(join(root, "output"));
  writeFileSync(join(root, "output/coverage-final.json"), '{"stale":true}');
  return { root, provider, lock };
}
const options = {
  configFile: "vitest.config.mjs",
  inventory: { src: ["source.ts"], test: ["source.test.ts"] },
  out: "output",
  maxWorkers: 1,
  timeoutMs: 10_000,
};
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  for (const root of temporary) rmSync(root, { recursive: true, force: true });
});

describe("explicit compatibility provider evidence", () => {
  it("binds the actual selected package, lock and runner alongside real source execution", async () => {
    const f = fixture();
    vi.stubEnv("JRIG_VITEST_PROVIDER_ROOT", f.provider);
    const result = await collectWorkspaceCoverage({ ...options, root: f.root });
    expect(result.complete).toBe(true);
    if (!result.complete) throw new Error(JSON.stringify(result.report));
    const caller = createRequire(join(f.provider, "package.json"));
    const pkg = caller.resolve("vitest/package.json");
    expect(result.report.identity.compatibilityProvider).toEqual({
      packageSha256: digest(join(f.provider, "package.json")),
      lockSha256: digest(f.lock),
      runnerSha256: digest(join(dirname(pkg), "vitest.mjs")),
    });
    expect(result.report.identity.vitestVersion).toBe(
      (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version,
    );
  }, 30_000);

  it("refuses changed provider lock bytes instead of publishing successful coverage", async () => {
    const f = fixture(true);
    vi.stubEnv("JRIG_VITEST_PROVIDER_ROOT", f.provider);
    const result = await collectWorkspaceCoverage({ ...options, root: f.root });
    expect(result.complete).toBe(false);
    if (!result.complete)
      expect(result.report.reasons).toContain("Collector inputs changed during measurement");
    expect(() => readFileSync(join(f.root, "output/coverage-final.json"))).toThrow(/ENOENT/);
  }, 30_000);

  it("refuses an explicitly empty provider without falling back to ambient tools", async () => {
    const f = fixture();
    vi.stubEnv("JRIG_VITEST_PROVIDER_ROOT", "");
    const result = await collectWorkspaceCoverage({ ...options, root: f.root });
    expect(result.complete).toBe(false);
    if (!result.complete)
      expect(result.report.reasons).toContain("Invalid explicit Vitest provider root");
    expect(() => readFileSync(join(f.root, "output/coverage-final.json"))).toThrow(/ENOENT/);
  });
});
