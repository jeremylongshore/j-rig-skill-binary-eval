import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerValidateCommand } from "./validate.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "validate-command-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Every exit site ends its branch; returning avoids injecting an exception
  // into the command's own error handler while retaining the exact exit code.
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(name: string): string {
  return fileURLToPath(new URL(`../../../core/fixtures/${name}`, import.meta.url));
}

function document(content: string): string {
  const path = join(directory, "input.yaml");
  writeFileSync(path, content);
  return path;
}

async function invoke(path: string, extra: string[] = []): Promise<void> {
  const program = new Command().exitOverride();
  registerValidateCommand(program);
  await program.parseAsync(["validate", path, ...extra], { from: "user" });
}

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((args) => String(args[0]))
    .join("\n");
}

function expectExit(code: number): void {
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(code);
}

describe("validate registered command", () => {
  it.each([
    ["eval-spec", "eval spec"],
    ["eval-contract", "eval contract"],
  ])("validates actual %s YAML with JSON output", async (file, label) => {
    await invoke(fixture(`valid/${file}.yaml`), ["--json"]);
    expect(JSON.parse(output())).toEqual({ valid: true, type: label, errors: [] });
    expectExit(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("prints spec counts and configured models", async () => {
    await invoke(fixture("valid/eval-spec.yaml"));
    expect(output()).toContain("Valid eval spec: commit-message-writer");
    expect(output()).toContain("4 criteria, 5 test cases, models: sonnet, haiku");
    expectExit(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("prints schema-default models when the document omits them", async () => {
    const spec = readFileSync(fixture("valid/eval-spec.yaml"), "utf8");
    const withoutModels = spec.replace("models:\n  - sonnet\n  - haiku\n", "");
    expect(withoutModels).not.toContain("models:");
    await invoke(document(withoutModels));
    expect(output()).toContain("4 criteria, 5 test cases, models: sonnet");
    expect(output()).not.toContain("haiku");
    expectExit(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("prints contract identity without spec counts", async () => {
    await invoke(fixture("valid/eval-contract.yaml"), ["--contract"]);
    expect(output()).toContain("Valid eval contract: commit-message-writer");
    expect(output()).not.toContain("criteria,");
    expectExit(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("explicit contract mode rejects a spec and reports structured errors", async () => {
    await invoke(fixture("valid/eval-spec.yaml"), ["--contract", "--json"]);
    const result = JSON.parse(output());
    expect(result.valid).toBe(false);
    expect(result.type).toBe("eval contract");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "contract_version", message: expect.any(String) }),
      ]),
    );
    expectExit(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports real schema errors on stderr without success output", async () => {
    await invoke(fixture("invalid/eval-spec-missing-fields.yaml"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Invalid eval spec"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("criteria"));
    expect(console.log).not.toHaveBeenCalled();
    expectExit(1);
  });

  it("reports malformed YAML as validation failure", async () => {
    await invoke(document("spec_version: ["), ["--json"]);
    const result = JSON.parse(output());
    expect(result.valid).toBe(false);
    expect(result.type).toBe("eval spec");
    expect(result.errors.length).toBeGreaterThan(0);
    expectExit(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("preserves raw-content contract detection even inside a comment", async () => {
    const spec = readFileSync(fixture("valid/eval-spec.yaml"), "utf8");
    await invoke(document(`${spec}\n# contract_version: documented marker\n`), ["--json"]);
    expect(JSON.parse(output())).toMatchObject({ valid: false, type: "eval contract" });
    expectExit(1);
  });

  it.each(["missing", "directory"])("reports %s read failures as runtime errors", async (kind) => {
    await invoke(kind === "missing" ? join(directory, "absent.yaml") : directory, ["--json"]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^Error: /));
    expect(console.log).not.toHaveBeenCalled();
    expectExit(1);
  });
});
