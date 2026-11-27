import ts from "typescript";
import { snapshot } from "./workspace-inventory.ts";
import { CollectionError } from "./workspace-coverage-contract.ts";
import type { CoverageManifest } from "./workspace-coverage-contract.ts";

/** Conservative subset of the upstream TypeScript no-runtime classification.
 * Runtime import/export syntax and value declarations never receive exemptions,
 * even when TypeScript might elide them under a particular compiler setting.
 */
export function isTypeOnlySource(path: string, bytes: Buffer): boolean {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const checked = ts.transpileModule(text, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  if (
    checked.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  ) {
    throw new CollectionError(`TypeScript syntax invalid: ${path}`);
  }
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return source.statements.every(
    (node) =>
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEmptyStatement(node) ||
      (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true) ||
      (ts.isExportDeclaration(node) && node.isTypeOnly),
  );
}

export function noRuntimeSources(manifest: CoverageManifest) {
  return snapshot(
    manifest.root,
    manifest.files.filter((file) => file.kind === "src").map((file) => file.path),
  )
    .filter((file) => {
      if (file.sha256 !== manifest.files.find((entry) => entry.path === file.path)?.sha256) {
        throw new CollectionError(`Source changed: ${file.path}`);
      }
      return isTypeOnlySource(file.path, file.bytes);
    })
    .map((file) => ({
      path: file.path,
      kind: "src" as const,
      sha256: file.sha256,
      reason: "proven-type-only; no runtime coverage synthesized",
      classifier: "typescript-type-statements/v1",
    }));
}
