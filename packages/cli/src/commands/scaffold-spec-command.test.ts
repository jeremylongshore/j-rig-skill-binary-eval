import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { parse } from "yaml";
import { SkillEvalSpecSchema } from "@j-rig/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerScaffoldSpecCommand } from "./scaffold-spec.js";

let directory: string;
const skillMd = `---
name: document-helper
description: Organizes documents. Use when the user asks to organize documents.
---
# Document helper
Organize the supplied documents by subject and explain the grouping.
`;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scaffold-command-"));
  writeFileSync(join(directory, "SKILL.md"), skillMd);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // All terminal branches return, so a returning boundary spy cannot fall through.
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  // The generic registry route uses only these synthetic credentials. All fetches
  // are intercepted; the explicit OpenAI case also replaces its preset key.
  vi.stubEnv("LLM_BASE_URL", "https://draft-fixture.invalid/v1");
  vi.stubEnv("LLM_API_KEY", "synthetic-draft-fixture-key");
  vi.stubEnv("LLM_MODEL", "fixture-draft-model");
  vi.stubEnv("LLM_PROVIDER", "fixture-provider");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected provider request")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

async function invoke(extra: string[] = [], skillDir = directory): Promise<void> {
  const program = new Command().exitOverride();
  registerScaffoldSpecCommand(program);
  await program.parseAsync(["scaffold-spec", skillDir, ...extra], { from: "user" });
}

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((args) => String(args[0]))
    .join("\n");
}

function specAt(path = join(directory, "eval-spec.yaml")) {
  return SkillEvalSpecSchema.parse(parse(readFileSync(path, "utf8")));
}

function draftedResponse(): string {
  return JSON.stringify({
    criteria: [
      {
        id: "groups",
        description: "Documents are grouped by subject.",
        blocker: true,
        judge_prompt: "Does the response group documents by subject?",
      },
      { id: "bad", description: "Ungradeable claim", judge_prompt: "Check SKILL.md?" },
    ],
    test_cases: [
      {
        id: "group-example",
        description: "Group two documents",
        tier: "core",
        prompt: "Organize my gardening and cooking notes.",
        criteria_ids: ["groups"],
      },
    ],
  });
}

function respond(content = draftedResponse()): void {
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

function expectRefusal(message: string): void {
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining(message));
  expect(console.log).not.toHaveBeenCalled();
  expect(process.stdout.write).not.toHaveBeenCalled();
  expect(existsSync(join(directory, "eval-spec.yaml"))).toBe(false);
}

describe("scaffold-spec registered command", () => {
  it("writes a loadable baseline with explicit generated provenance", async () => {
    await invoke();
    const spec = specAt();
    expect(spec.skill_name).toBe("document-helper");
    expect(spec.tags).toEqual(["generated", "baseline"]);
    expect(spec.criteria.map((item) => item.id)).toEqual([
      "output-not-empty",
      "engages-with-stated-intent",
      "no-prompt-leakage",
    ]);
    expect(spec.test_cases).toHaveLength(4);
    expect(output()).toContain("Wrote baseline eval spec:");
    expect(output()).toContain("3 criteria, 4 test cases");
    expect(fetch).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("writes to the explicit output path", async () => {
    const path = join(directory, "custom.yaml");
    await invoke(["--out", path]);
    expect(specAt(path).skill_name).toBe("document-helper");
    expect(existsSync(join(directory, "eval-spec.yaml"))).toBe(false);
    expect(output()).toContain(path);
  });

  it("previews valid YAML without touching an existing output file", async () => {
    const path = join(directory, "eval-spec.yaml");
    writeFileSync(path, "reviewed content\n");
    await invoke(["--stdout", "--out", path]);
    expect(process.stdout.write).toHaveBeenCalledTimes(1);
    const yaml = String(vi.mocked(process.stdout.write).mock.calls[0]![0]);
    expect(yaml).toContain("# This is a BASELINE spec");
    expect(SkillEvalSpecSchema.parse(parse(yaml)).tags).toEqual(["generated", "baseline"]);
    expect(readFileSync(path, "utf8")).toBe("reviewed content\n");
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("refuses an existing spec once and preserves every byte", async () => {
    const path = join(directory, "eval-spec.yaml");
    writeFileSync(path, "reviewed content\n");
    await invoke();
    expect(readFileSync(path, "utf8")).toBe("reviewed content\n");
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Refusing to overwrite existing spec"),
    );
    expect(console.log).not.toHaveBeenCalled();
  });

  it("the built CLI exits nonzero and preserves an existing spec on refusal", () => {
    const path = join(directory, "eval-spec.yaml");
    writeFileSync(path, "reviewed content\n");
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../../dist/index.js", import.meta.url)), "scaffold-spec", directory],
      { encoding: "utf8", env: { NO_COLOR: "1" } },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Refusing to overwrite existing spec");
    expect(readFileSync(path, "utf8")).toBe("reviewed content\n");
  });

  it("overwrites only when force is explicit", async () => {
    writeFileSync(join(directory, "eval-spec.yaml"), "reviewed content\n");
    await invoke(["--force"]);
    expect(specAt().skill_name).toBe("document-helper");
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("reports output filesystem failure without a success receipt", async () => {
    await invoke(["--out", join(directory, "missing", "output.yaml")]);
    expectRefusal("ENOENT");
  });

  it("refuses a missing skill before any provider or output operation", async () => {
    await invoke(["--draft"], join(directory, "missing"));
    expectRefusal("SKILL.md not found");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses invalid skill frontmatter rather than fabricating a baseline", async () => {
    writeFileSync(join(directory, "SKILL.md"), "---\nname: 123\n---\nBody\n");
    await invoke();
    expectRefusal("SKILL.md parse error");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps draft criteria nonblocking and requires human review", async () => {
    respond();
    await invoke(["--draft"]);
    const spec = specAt();
    expect(spec.tags).toEqual(["generated", "draft", "needs-review"]);
    expect(spec.criteria).toHaveLength(4);
    expect(spec.criteria[3]).toMatchObject({ id: "fn-groups", method: "judge", blocker: false });
    expect(spec.criteria[3]!.description).toContain("suggested blocker");
    expect(spec.test_cases.at(-1)).toMatchObject({
      id: "fn-group-example",
      criteria_ids: ["output-not-empty", "fn-groups"],
    });
    expect(output()).toContain("Wrote DRAFT eval spec:");
    expect(output()).toContain("dropped: criterion bad:");
    expect(readFileSync(join(directory, "eval-spec.yaml"), "utf8")).toContain(
      "fixture-provider/fixture-draft-model",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://draft-fixture.invalid/v1/chat/completions");
    const request = JSON.parse(String(init!.body));
    expect(request.model).toBe("fixture-draft-model");
    expect(request.messages[0].content).toContain(skillMd);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("honors explicit provider and model through the real registry and adapter", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-fixture-key");
    respond();
    await invoke([
      "--draft",
      "--provider",
      "openai",
      "--model",
      "explicit-fixture-model",
      "--stdout",
    ]);
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body));
    expect(request.model).toBe("explicit-fixture-model");
    const yaml = String(vi.mocked(process.stdout.write).mock.calls[0]![0]);
    expect(yaml).toContain("openai/explicit-fixture-model");
    expect(process.exit).not.toHaveBeenCalled();
    expect(SkillEvalSpecSchema.parse(parse(yaml)).tags).toContain("needs-review");
    expect(existsSync(join(directory, "eval-spec.yaml"))).toBe(false);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("requires an explicit model when the custom provider has no default", async () => {
    vi.stubEnv("LLM_MODEL", "");
    await invoke(["--draft"]);
    expectRefusal("has no default model");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses Opus drafting before provider I/O", async () => {
    await invoke(["--draft", "--model", "Claude-Opus-4"]);
    expectRefusal("--draft may not run on opus");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses unknown explicit providers without falling back", async () => {
    await invoke(["--draft", "--provider", "missing-fixture-provider"]);
    expectRefusal("unknown provider");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes nothing when no drafted functional criterion survives", async () => {
    respond(JSON.stringify({ criteria: [], test_cases: [] }));
    await invoke(["--draft"]);
    expectRefusal("no usable functional criteria");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for a malformed model response", async () => {
    respond("This is prose, not a draft.");
    await invoke(["--draft"]);
    expectRefusal("no JSON object");
  });

  it("reports provider transport failure without writing or claiming success", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("fixture transport failed"));
    await invoke(["--draft"]);
    expectRefusal("fixture transport failed");
  });
});
