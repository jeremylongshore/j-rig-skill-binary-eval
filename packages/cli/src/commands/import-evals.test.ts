import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareScriptedImport } from "./import-evals.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jrig-import-"));
  roots.push(root);
  mkdirSync(join(root, "evals"));
  const canary = join(root, "must-not-run");
  writeFileSync(
    join(root, "evals/run_evals.py"),
    `raise RuntimeError("must never execute during import")\n`,
  );
  writeFileSync(join(root, "input.txt"), "authored fixture");
  const source = {
    skill_name: "whiteglove-pdf",
    evals: [
      {
        id: 1,
        scenario: "happy",
        prompt: "prose",
        expected_output: "prose",
        expectations: [],
        files: ["input.txt"],
        assertions: [{ cmd: `touch ${canary}`, expect_exit: 0 }],
      },
    ],
  };
  writeFileSync(join(root, "evals/evals.json"), JSON.stringify(source));
  return { root, canary, source, output: join(root, "imported") };
}
describe("import-evals command boundary", () => {
  it("writes reviewable definitions while neither Python nor imported commands run", () => {
    const f = fixture();
    prepareScriptedImport({
      root: f.root,
      output: f.output,
      python: process.execPath,
      timeoutMs: 1000,
    });
    expect(existsSync(f.canary)).toBe(false);
    const imported = JSON.parse(readFileSync(join(f.output, "import.json"), "utf8"));
    expect(imported.task.input.source).toEqual(f.source);
    expect(imported.task.input.fixtures[0].path).toBe("input.txt");
    expect(imported.config.harness.args).toEqual([
      join(f.root, "evals/run_evals.py"),
      "--structured",
    ]);
    expect(() =>
      prepareScriptedImport({
        root: f.root,
        output: f.output,
        python: process.execPath,
        timeoutMs: 1000,
      }),
    ).toThrow();
  });
  it("retains an explicit virtualenv-style interpreter symlink invocation path", () => {
    const f = fixture();
    const python = join(f.root, "venv-python");
    symlinkSync(process.execPath, python);
    prepareScriptedImport({ root: f.root, output: f.output, python, timeoutMs: 1000 });
    const config = JSON.parse(readFileSync(join(f.output, "config.json"), "utf8"));
    expect(config.harness.command).toBe(python);
  });
  it("rejects execution paths unsupported by the authored shell variable contract", () => {
    const f = fixture();
    const python = join(f.root, "python with-space");
    symlinkSync(process.execPath, python);
    expect(() =>
      prepareScriptedImport({ root: f.root, output: f.output, python, timeoutMs: 1000 }),
    ).toThrow("execution paths");
    expect(existsSync(f.output)).toBe(false);
  });
  it("rejects missing input before creating executable definitions", () => {
    const f = fixture();
    rmSync(join(f.root, "input.txt"));
    expect(() =>
      prepareScriptedImport({
        root: f.root,
        output: f.output,
        python: process.execPath,
        timeoutMs: 1000,
      }),
    ).toThrow();
    expect(existsSync(f.output)).toBe(false);
    expect(existsSync(f.canary)).toBe(false);
  });
});
