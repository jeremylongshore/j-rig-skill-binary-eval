import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { snapshot, testScopes, workspaceFiles } from "./workspace-inventory.ts";
import { CollectionError } from "./workspace-coverage-contract.ts";

export interface CoverageInventory {
  src: string[];
  test: string[];
}
const sourceRootPattern = /^packages\/[^/]+\/src\//;
const supportedSource = /\.(?:ts|tsx|mts|cts)$/;
const code = /\.[cm]?[jt]sx?$/;
// Same production boundary as workspace-architecture: test/spec, fixture/test
// directories and declarations are not production. Type-only .ts modules stay.
const excluded =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__(?:tests|fixtures)__(?:\/|$)|\.d\.[cm]?ts$)/;
const packageConfig = /^packages\/[^/]+\/(?:tsup|vitest)\.config\.ts$/;

export function defaultCoverageInventory(input: string): CoverageInventory {
  const root = resolve(input);
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  if (!/^packages:\s*\n\s+-\s+["']?packages\/\*["']?\s*$/.test(workspace.trim())) {
    throw new CollectionError("Unsupported coverage workspace layout; expected packages/*");
  }
  const listed = workspaceFiles(root);
  const listedSet = new Set(listed);
  const src: string[] = [];
  const packageNames = new Set<string>();
  for (const file of listed) {
    if (
      /^packages\/[^/]+\//.test(file) &&
      code.test(file) &&
      !sourceRootPattern.test(file) &&
      !packageConfig.test(file)
    ) {
      throw new CollectionError(`Unsupported production location: ${file}`);
    }
  }
  const matchesTest = (file: string) => testScopes.some((scope) => scope.pattern.test(file));
  function checkTest(file: string) {
    if (matchesTest(file) && !listedSet.has(file))
      throw new CollectionError(`Test file omitted by Git inventory: ${file}`);
  }
  function walkTests(directory: string) {
    if (!existsSync(directory)) return;
    if (lstatSync(directory).isSymbolicLink())
      throw new CollectionError(`Symlink in test inventory: ${relative(root, directory)}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Vitest excludes node_modules; never descend into dependencies.
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const file = relative(root, path).split("\\").join("/");
      if (entry.isSymbolicLink()) throw new CollectionError(`Symlink in test inventory: ${file}`);
      if (entry.isDirectory()) walkTests(path);
      else checkTest(file);
    }
  }
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const file = relative(root, path).split("\\").join("/");
      if (entry.isSymbolicLink())
        throw new CollectionError(`Symlink in production inventory: ${file}`);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      checkTest(file);
      if (excluded.test(file)) continue;
      if (!entry.isFile() || !supportedSource.test(file)) {
        throw new CollectionError(`Unsupported production extension or file type: ${file}`);
      }
      if (!listedSet.has(file))
        throw new CollectionError(`Production file omitted by Git inventory: ${file}`);
      src.push(file);
    }
  }
  const packageRoot = join(root, "packages");
  if (lstatSync(packageRoot).isSymbolicLink())
    throw new CollectionError("Symlinked packages directory");
  for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new CollectionError(`Symlinked workspace package: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const directory = join(packageRoot, entry.name);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (typeof manifest.name !== "string" || !manifest.name || packageNames.has(manifest.name)) {
      throw new CollectionError(`Missing or duplicate workspace package name: ${entry.name}`);
    }
    packageNames.add(manifest.name);
    const source = join(directory, "src");
    if (!existsSync(source)) {
      if (manifest.name === "@j-rig/dashboard") continue;
      throw new CollectionError(`Missing production source root: packages/${entry.name}/src`);
    }
    if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isDirectory()) {
      throw new CollectionError(`Invalid production source root: packages/${entry.name}/src`);
    }
    const before = src.length;
    walk(source);
    if (src.length === before)
      throw new CollectionError(`Empty production inventory: ${entry.name}`);
  }
  // Git also retains deleted tracked files. Refuse them rather than silently
  // dropping them because the directory walk no longer finds them.
  const discovered = new Set(src);
  for (const file of listed) {
    if (sourceRootPattern.test(file) && !excluded.test(file) && !discovered.has(file)) {
      throw new CollectionError(`Production inventory mismatch: ${file}`);
    }
  }
  walkTests(join(root, "tests"));
  walkTests(join(root, "scripts"));
  const test = listed.filter(matchesTest);
  if (!src.length || !test.length)
    throw new CollectionError("Empty default production or test inventory");
  src.sort();
  test.sort();
  snapshot(root, [...src, ...test]);
  return { src, test };
}
