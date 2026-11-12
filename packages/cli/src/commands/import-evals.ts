import type { Command } from "commander";
import {
  mkdirSync,
  writeFileSync,
  realpathSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants,
  statSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { importScriptedEvals, parseScriptedSource, sha256Bytes, SCRIPTED_LIMIT } from "@j-rig/core";

function confinedFile(root: string, path: string): Buffer {
  const candidate = resolve(root, path);
  const actual = realpathSync(candidate);
  const rel = relative(root, actual);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
    throw new Error("input file must stay within the authored repository");
  const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SCRIPTED_LIMIT)
      throw new Error("input must be a regular file no larger than 4 MiB");
    const bytes = Buffer.alloc(SCRIPTED_LIMIT + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > SCRIPTED_LIMIT) throw new Error("input grew beyond 4 MiB");
    return bytes.subarray(0, used);
  } finally {
    closeSync(fd);
  }
}
export function prepareScriptedImport(options: {
  root: string;
  python: string;
  output: string;
  timeoutMs: number;
}): void {
  const root = realpathSync(options.root);
  const python = resolve(options.python);
  if (/[\s*?[]/.test(root) || /[\s*?[]/.test(python))
    throw new Error(
      "authored runner does not support whitespace or glob characters in execution paths",
    );
  if (!statSync(python).isFile())
    throw new Error("Python invocation path must resolve to a regular executable file");
  const source = confinedFile(root, "evals/evals.json");
  const parsed = parseScriptedSource(source);
  const fixtures = [...new Set(parsed.evals.flatMap((item) => item.files ?? []))].map((path) => ({
    path,
    sha256: sha256Bytes(confinedFile(root, path)),
  }));
  const runner = join(root, "evals/run_evals.py");
  const imported = importScriptedEvals(source, {
    python,
    runner,
    cwd: root,
    runnerSha256: sha256Bytes(confinedFile(root, "evals/run_evals.py")),
    fixtures,
    timeoutMs: options.timeoutMs,
  });
  // A fresh directory avoids overwriting existing evaluations. No execution occurs here.
  mkdirSync(resolve(options.output), { recursive: false, mode: 0o700 });
  const written: string[] = [];
  try {
    for (const [name, value] of [
      ["task", imported.task],
      ["config", imported.config],
      ["import", imported],
    ] as const) {
      const path = join(options.output, `${name}.json`);
      const fd = openSync(path, "wx", 0o600);
      written.push(path);
      try {
        writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
    }
  } catch (error) {
    for (const path of written) unlinkSync(path);
    rmdirSync(resolve(options.output));
    throw error;
  }
}
export function registerImportEvalsCommand(program: Command): void {
  program
    .command("import-evals")
    .description("Import an authored Whiteglove scripted suite without executing it")
    .requiredOption("--root <path>", "Authored repository root")
    .requiredOption("--python <path>", "Explicit trusted Python executable")
    .requiredOption("--output <path>", "New private import directory")
    .requiredOption("--timeout-ms <number>", "Explicit entire-suite runtime limit")
    .action((opts: { root: string; python: string; output: string; timeoutMs: string }) => {
      try {
        prepareScriptedImport({ ...opts, timeoutMs: Number(opts.timeoutMs) });
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Import failed");
        process.exitCode = 1;
      }
    });
}
