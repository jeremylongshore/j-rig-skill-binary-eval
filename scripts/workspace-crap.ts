import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultCoverageInventory } from "./workspace-coverage-inventory.ts";
import { sha256 } from "./workspace-coverage-contract.ts";
import { snapshot } from "./workspace-inventory.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a measurement object");
  }
  return value as Record<string, unknown>;
}

function currentInventory(root: string) {
  const inventory = defaultCoverageInventory(root);
  return snapshot(root, [...inventory.src, ...inventory.test]).map(({ path, sha256 }) => ({
    path,
    sha256,
    kind: inventory.test.includes(path) ? "test" : "src",
  }));
}

function matchesInventory(value: unknown, expected: ReturnType<typeof currentInventory>) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => {
      const file = record(entry);
      return (
        file.path === expected[index].path &&
        file.sha256 === expected[index].sha256 &&
        file.kind === expected[index].kind
      );
    })
  );
}

function validateScope(value: unknown, files: number, typeOnly = false) {
  const scope = record(value);
  for (const key of [
    "discovered_files",
    "scored_files",
    "discovered_functions",
    "scored_functions",
  ]) {
    if (!Number.isSafeInteger(scope[key]) || Number(scope[key]) < 0) {
      throw new Error(`Invalid strict denominator: ${key}`);
    }
  }
  const excluded = typeOnly ? scope.type_only_files : 0;
  if (
    !Number.isSafeInteger(excluded) ||
    Number(excluded) < 0 ||
    scope.discovered_files !== files ||
    Number(scope.scored_files) + Number(excluded) !== files ||
    scope.discovered_functions !== scope.scored_functions ||
    (Number(scope.scored_files) > 0 && Number(scope.scored_functions) === 0)
  )
    throw new Error("Strict measurement omitted files or functions");
}

function validateResult(
  value: unknown,
  status: number | null,
  inventory: ReturnType<typeof currentInventory>,
) {
  const result = record(value);
  if (
    result.schema_version !== "crap-measurement/v1" ||
    result.complete !== true ||
    typeof result.pass !== "boolean" ||
    ![0, 1].includes(status ?? -1) ||
    (status === 0) !== result.pass
  ) {
    throw new Error(
      "Strict provider failed, returned incomplete evidence or disagreed with its exit",
    );
  }
  const scopes = record(result.scopes);
  validateScope(scopes.src, inventory.filter(({ kind }) => kind === "src").length, true);
  validateScope(scopes.test, inventory.filter(({ kind }) => kind === "test").length);
  const thresholds = record(result.thresholds);
  if (
    thresholds.production_max !== 30 ||
    thresholds.test_max !== 15 ||
    thresholds.project_avg_max !== 10
  ) {
    throw new Error("Strict provider did not enforce the repository's 30/15/10 limits");
  }
  return result;
}

/** Adapt a complete worker receipt to the unmodified, explicitly supplied upstream scorer. */
export function measureWorkspaceCrap(
  rootInput: string,
  providerInput: string,
  coverageInput = "coverage/workspace",
) {
  const root = resolve(rootInput);
  const provider = resolve(providerInput);
  const coverage = resolve(root, coverageInput);
  const out = join(root, "coverage/strict");
  mkdirSync(out, { recursive: true });
  rmSync(join(out, "summary.json"), { force: true });
  rmSync(join(out, "provider.json"), { force: true });
  const collected = record(JSON.parse(readFileSync(join(coverage, "collection.json"), "utf8")));
  const inventory = currentInventory(root);
  const coveragePath = join(coverage, "coverage-final.json");
  const coverageHash = sha256(readFileSync(coveragePath));
  if (
    collected.complete !== true ||
    !matchesInventory(collected.inventory, inventory) ||
    collected.coverageSha256 !== coverageHash
  ) {
    throw new Error(
      "Coverage receipt is incomplete, stale or differs from the full current inventory",
    );
  }
  const providerFiles = [
    "scripts/crap-score.py",
    "scripts/crap_strict.py",
    "scripts/crap_typescript.mjs",
  ];
  const identity = snapshot(provider, providerFiles).map(({ path, sha256 }) => ({ path, sha256 }));
  const args = [
    join(provider, providerFiles[0]),
    "--strict-measurement",
    "--root",
    root,
    "--lang",
    "typescript",
    "--target",
    "both",
    "--coverage-json",
    coveragePath,
    "--out",
    out,
    "--json",
  ];
  for (const file of inventory)
    args.push(file.kind === "src" ? "--source-glob" : "--test-glob", file.path);
  const execution = spawnSync("python3", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (execution.error || execution.signal) throw new Error("Strict provider execution failed");
  const result = validateResult(
    JSON.parse(readFileSync(join(out, "summary.json"), "utf8")),
    execution.status,
    inventory,
  );
  const after = snapshot(provider, providerFiles).map(({ path, sha256 }) => ({ path, sha256 }));
  if (
    JSON.stringify(after) !== JSON.stringify(identity) ||
    JSON.stringify(currentInventory(root)) !== JSON.stringify(inventory) ||
    sha256(readFileSync(coveragePath)) !== coverageHash
  ) {
    throw new Error("Strict measurement inputs changed while scoring");
  }
  writeFileSync(
    join(out, "provider.json"),
    JSON.stringify({ identity, argv: args, coverageSha256: coverageHash }, null, 2) + "\n",
  );
  return {
    complete: true,
    pass: result.pass,
    scopes: result.scopes,
    thresholds: result.thresholds,
    coverage_basis: result.coverage_basis,
    summary: "coverage/strict/summary.json",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { provider: { type: "string" }, root: { type: "string", default: "." } },
    });
    if (!values.provider) throw new Error("--provider must name a reviewed upstream checkout");
    const result = measureWorkspaceCrap(values.root!, values.provider);
    console.log(JSON.stringify(result));
    process.exitCode = result.pass ? 0 : 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        complete: false,
        reason: error instanceof Error ? error.message : "Strict measurement failed",
      }),
    );
    process.exitCode = 2;
  }
}
