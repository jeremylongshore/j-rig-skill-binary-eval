#!/usr/bin/env -S node --experimental-strip-types
/** Repo-owned import-boundary check; not a sandbox or a general purity proof.
 * Authority: package.json dependency contracts, CLAUDE.md's CLI leaf boundary,
 * and packages/refiner-core/README.md's no-I/O core contract.
 */
import { builtinModules } from "node:module";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

interface Package {
  name: string;
  directory: string;
  runtime: Set<string>;
  development: Set<string>;
  files: string[];
}
export interface ArchitectureViolation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}
export interface ArchitectureReport {
  schema_version: "workspace-architecture/v1";
  result: "PASS" | "FAIL";
  packages: number;
  production_files: number;
  import_edges: number;
  placeholders: string[];
  violations: ArchitectureViolation[];
}
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const ioBuiltins = new Set([
  "fs",
  "http",
  "http2",
  "https",
  "net",
  "tls",
  "dns",
  "dgram",
  "child_process",
  "cluster",
  "worker_threads",
  "readline",
  "repl",
  "module",
  "inspector",
]);
const ioPackages = new Set([
  "@j-rig/core",
  "@j-rig/db",
  "@j-rig/migrate",
  "@intentsolutions/refiner",
  "@intentsolutions/jrig-cli",
]);
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/;
const testPattern =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[/\\])(?:__tests__|__fixtures__)(?:[/\\]|$))/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object");
  return value as Record<string, unknown>;
}
function dependencies(value: unknown): string[] {
  if (value === undefined) return [];
  const entries = Object.entries(object(value));
  if (entries.some(([, version]) => typeof version !== "string"))
    throw new Error("invalid dependency version");
  return entries.map(([name]) => name);
}
function inside(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function files(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink in source inventory: ${path}`);
    if (entry.isDirectory()) result.push(...files(path));
    else if (
      entry.isFile() &&
      sourcePattern.test(path) &&
      !/\.d\.[cm]?ts$/.test(path) &&
      !testPattern.test(path)
    )
      result.push(path);
  }
  return result;
}
function packageName(specifier: string): string {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

export function checkWorkspaceArchitecture(root: string): ArchitectureReport {
  root = resolve(root);
  const report: ArchitectureReport = {
    schema_version: "workspace-architecture/v1",
    result: "PASS",
    packages: 0,
    production_files: 0,
    import_edges: 0,
    placeholders: [],
    violations: [],
  };
  const add = (file: string, line: number, rule: string, detail: string) => {
    report.violations.push({ file: relative(root, file).split(sep).join("/"), line, rule, detail });
  };
  try {
    // Refuse unsupported workspace layouts instead of quietly checking a subset.
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    if (!/^packages:\s*\n\s+-\s+["']?packages\/\*["']?\s*$/.test(workspace.trim()))
      throw new Error(
        "expected workspace packages/*; update inventory support before changing layout",
      );
    const packages: Package[] = [];
    for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isSymbolicLink()) throw new Error(`symlinked workspace package: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      const directory = join(root, "packages", entry.name);
      const manifest = object(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")));
      if (typeof manifest.name !== "string" || !manifest.name)
        throw new Error(`missing package name: ${entry.name}`);
      const source = join(directory, "src");
      if (existsSync(source) && lstatSync(source).isSymbolicLink())
        throw new Error(`symlinked source root: ${manifest.name}`);
      const production = existsSync(source) ? files(source) : [];
      if (production.length === 0) {
        if (manifest.name === "@j-rig/dashboard" && !existsSync(source))
          report.placeholders.push(manifest.name);
        else throw new Error(`no production source measured: ${manifest.name}`);
      }
      packages.push({
        name: manifest.name,
        directory,
        runtime: new Set([
          ...dependencies(manifest.dependencies),
          ...dependencies(manifest.optionalDependencies),
          ...dependencies(manifest.peerDependencies),
        ]),
        development: new Set(dependencies(manifest.devDependencies)),
        files: production,
      });
    }
    if (packages.length === 0) throw new Error("no workspace packages discovered");
    const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
    if (byName.size !== packages.length) throw new Error("duplicate workspace package names");
    const edges = new Map(packages.map((pkg) => [pkg.name, new Set<string>()]));
    report.packages = packages.length;
    for (const pkg of packages) {
      report.production_files += pkg.files.length;
      for (const file of pkg.files) {
        const source = readFileSync(file, "utf8");
        const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const diagnostics =
          ts.transpileModule(source, {
            fileName: file,
            reportDiagnostics: true,
            compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
          }).diagnostics ?? [];
        for (const diagnostic of diagnostics.filter(
          (d) => d.category === ts.DiagnosticCategory.Error,
        ))
          add(file, 1, "parse-error", ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
        const checkImport = (node: ts.Node, specifier: string, typeOnly: boolean) => {
          report.import_edges++;
          const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
          if (testPattern.test(specifier)) add(file, line, "production-imports-test", specifier);
          if (specifier.startsWith(".") || isAbsolute(specifier)) {
            const target = resolve(dirname(file), specifier);
            if (!inside(join(pkg.directory, "src"), target))
              add(file, line, "package-source-boundary", specifier);
            return;
          }
          const builtin = specifier.replace(/^node:/, "");
          const dependency = packageName(specifier);
          if (builtins.has(builtin)) {
            if (
              !typeOnly &&
              pkg.name === "@intentsolutions/refiner-core" &&
              ioBuiltins.has(builtin.split("/")[0])
            )
              add(file, line, "refiner-core-no-io", specifier);
            return;
          }
          if (
            dependency !== pkg.name &&
            !pkg.runtime.has(dependency) &&
            !pkg.development.has(dependency)
          )
            add(
              file,
              line,
              "undeclared-dependency",
              `${specifier} (${typeOnly ? "type" : "runtime"})`,
            );
          if (!typeOnly && byName.has(dependency)) edges.get(pkg.name)?.add(dependency);
          if (!typeOnly && dependency === "@intentsolutions/jrig-cli" && pkg.name !== dependency)
            add(file, line, "cli-is-leaf", specifier);
          if (
            !typeOnly &&
            pkg.name === "@intentsolutions/refiner-core" &&
            ioPackages.has(dependency)
          )
            add(file, line, "refiner-core-no-io", specifier);
        };
        const visit = (node: ts.Node): void => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
            const clause = node.importClause;
            const bindings = clause?.namedBindings;
            const onlyTypes = Boolean(
              clause?.isTypeOnly ||
              (!clause?.name &&
                bindings &&
                ts.isNamedImports(bindings) &&
                bindings.elements.length > 0 &&
                bindings.elements.every((element) => element.isTypeOnly)),
            );
            checkImport(node, node.moduleSpecifier.text, onlyTypes);
          } else if (
            ts.isExportDeclaration(node) &&
            node.moduleSpecifier &&
            ts.isStringLiteralLike(node.moduleSpecifier)
          ) {
            const onlyTypes =
              node.isTypeOnly ||
              Boolean(
                node.exportClause &&
                ts.isNamedExports(node.exportClause) &&
                node.exportClause.elements.length > 0 &&
                node.exportClause.elements.every((element) => element.isTypeOnly),
              );
            checkImport(node, node.moduleSpecifier.text, onlyTypes);
          } else if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteralLike(node.argument.literal)
          )
            checkImport(node, node.argument.literal.text, true);
          else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            node.moduleReference.expression &&
            ts.isStringLiteralLike(node.moduleReference.expression)
          )
            checkImport(node, node.moduleReference.expression.text, node.isTypeOnly);
          else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === "require"))
          ) {
            const arg = node.arguments[0];
            if (arg && ts.isStringLiteralLike(arg)) checkImport(node, arg.text, false);
            else
              add(
                file,
                parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
                "unresolved-dynamic-import",
                "module specifier must be a literal for architecture verification",
              );
          }
          if (
            pkg.name === "@intentsolutions/refiner-core" &&
            (ts.isCallExpression(node) || ts.isNewExpression(node))
          ) {
            const expression = node.expression;
            const name = ts.isIdentifier(expression)
              ? expression.text
              : ts.isPropertyAccessExpression(expression) &&
                  ts.isIdentifier(expression.expression) &&
                  ["globalThis", "global"].includes(expression.expression.text)
                ? expression.name.text
                : "";
            if (["fetch", "WebSocket", "XMLHttpRequest"].includes(name))
              add(
                file,
                parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
                "refiner-core-no-io",
                name,
              );
          }
          ts.forEachChild(node, visit);
        };
        visit(parsed);
      }
    }
    const complete = new Set<string>();
    const visitPackage = (name: string, path: string[]): void => {
      if (path.includes(name)) {
        add(join(root, "packages"), 0, "workspace-runtime-cycle", [...path, name].join(" -> "));
        return;
      }
      if (complete.has(name)) return;
      for (const next of edges.get(name) ?? []) visitPackage(next, [...path, name]);
      complete.add(name);
    };
    for (const pkg of packages) visitPackage(pkg.name, []);
    if (report.production_files === 0) throw new Error("no production files measured");
  } catch (error) {
    add(root, 0, "incomplete-inventory", error instanceof Error ? error.message : String(error));
  }
  report.result = report.violations.length ? "FAIL" : "PASS";
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = checkWorkspaceArchitecture(process.argv[2] ?? process.cwd());
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === "PASS" ? 0 : 1;
}
