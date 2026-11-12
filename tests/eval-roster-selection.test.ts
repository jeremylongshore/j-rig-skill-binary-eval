import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script with no type declarations
import { loadRoster } from "../eval-roster/run-roster.mjs";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function roster(key = "plugin-brain", ref = "a".repeat(40)) {
  return {
    source: { githubRepo: "fixture/brain", ref },
    provider: "minimax",
    models: "MiniMax-M3",
    samples: 5,
    skills: [{ key, path: "skills/brain" }],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jrig-roster-selection-"));
  dirs.push(root);
  mkdirSync(join(root, "eval-roster"));
  mkdirSync(join(root, "packages/cli/dist"), { recursive: true });
  mkdirSync(join(root, "source/skills/brain"), { recursive: true });
  cpSync(
    new URL("../eval-roster/run-roster.mjs", import.meta.url),
    join(root, "eval-roster/run-roster.mjs"),
  );

  writeFileSync(join(root, "source/skills/brain/SKILL.md"), "Synthetic skill only\n");
  writeFileSync(
    join(root, "source/skills/brain/eval-spec.yaml"),
    "Synthetic spec consumed only by the test child\n",
  );
  writeFileSync(
    join(root, "packages/cli/dist/index.js"),
    `const fs=require('node:fs');
const args=process.argv.slice(2);const at=(name)=>args[args.indexOf(name)+1];
fs.writeFileSync(at('--emit-bundle'),JSON.stringify([{predicate:{gate_decision:'pass'}}]));
process.stdout.write(JSON.stringify({args}));`,
  );
  const source = join(root, "source");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Synthetic fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", "https://github.com/fixture/brain.git");
  git("add", "skills");
  git("-c", "core.hooksPath=/dev/null", "commit", "-m", "synthetic skill fixture");
  writeFileSync(
    join(root, "eval-roster/roster.json"),
    JSON.stringify(roster("default-brain", git("rev-parse", "HEAD"))),
  );
  return root;
}

function sourceRef(root: string): string {
  return JSON.parse(readFileSync(join(root, "eval-roster/roster.json"), "utf8")).source.ref;
}

function invoke(root: string, extra: string[] = [], extraEnv: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [
      join(root, "eval-roster/run-roster.mjs"),
      "--src",
      join(root, "source"),
      "--out",
      join(root, "output"),
      ...extra,
    ],
    { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, ...extraEnv } },
  );
}

describe("explicit roster selection without provider execution", () => {
  it("preserves the default roster and existing review/self-test options", () => {
    const root = fixture();
    expect(invoke(root).status).toBe(0);
    const rows = JSON.parse(readFileSync(join(root, "output/roster-summary.json"), "utf8"));
    expect(rows.map((row: { key: string }) => row.key)).toEqual(["default-brain"]);
    const { args } = JSON.parse(
      readFileSync(join(root, "output/default-brain.result.json"), "utf8"),
    );
    expect(args).toContain("--require-reviewed");
    expect(args).toContain("--run-self-test");
  });

  it("selects a relative per-repo roster and retains explicit provider/model overrides", () => {
    const root = fixture();
    writeFileSync(
      join(root, "registrar.json"),
      JSON.stringify(roster("registrar-brain", sourceRef(root))),
    );
    expect(
      invoke(root, [
        "--roster",
        "registrar.json",
        "--provider",
        "fixture",
        "--models",
        "fixture-model",
      ]).status,
    ).toBe(0);
    const [row] = JSON.parse(readFileSync(join(root, "output/roster-summary.json"), "utf8"));
    expect(row).toMatchObject({
      key: "registrar-brain",
      skillsCommit: sourceRef(root),
      status: "ok",
    });
    expect(existsSync(join(root, "output/default-brain.result.json"))).toBe(false);
    const { args } = JSON.parse(
      readFileSync(join(root, "output/registrar-brain.result.json"), "utf8"),
    );
    expect(args[args.indexOf("--provider") + 1]).toBe("fixture");
    expect(args[args.indexOf("--models") + 1]).toBe("fixture-model");
    expect(args[args.indexOf("--samples") + 1]).toBe("5");
  });

  it.each([{ suffix: [] }, { suffix: ["--provider", "fixture"] }])(
    "refuses a missing --roster value before writing output: %j",
    ({ suffix }) => {
      const root = fixture();
      const result = invoke(root, ["--roster", ...suffix]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--roster requires a file path");
      expect(existsSync(join(root, "output"))).toBe(false);
    },
  );

  it.each(["missing.json", "malformed.json"])(
    "refuses unreadable/invalid selected configuration %s",
    (name) => {
      const root = fixture();
      writeFileSync(join(root, "malformed.json"), "{not-json");
      expect(invoke(root, ["--roster", name]).status).toBe(1);
      expect(existsSync(join(root, "output"))).toBe(false);
    },
  );

  it.each([
    ["moving ref", { ...roster(), source: { ref: "main" } }],
    ["ref newline", roster("brain", "a".repeat(40) + "\n")],
    ["duplicate keys", { ...roster(), skills: [...roster().skills, ...roster().skills] }],
    ["key traversal", roster("../outside")],
    ["numeric key", { ...roster(), skills: [{ key: 12, path: "skills/brain" }] }],
    ["boolean key", { ...roster(), skills: [{ key: true, path: "skills/brain" }] }],
    ["key newline", roster("brain\n")],
    ["path traversal", { ...roster(), skills: [{ key: "brain", path: "../outside" }] }],
    ["empty roster", { ...roster(), skills: [] }],
    ["bad samples", { ...roster(), samples: 0 }],
  ])("refuses %s before evaluator or output effects", (_name, value) => {
    const root = fixture();
    const path = join(root, "selected.json");
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadRoster(path)).toThrow();
    expect(invoke(root, ["--roster", path]).status).toBe(1);
    expect(existsSync(join(root, "output"))).toBe(false);
  });
  it.each(["head", "origin", "dirty-skill", "untracked-spec-neighbor"])(
    "refuses source %s mismatch without evaluator effects",
    (kind) => {
      const root = fixture();
      if (kind === "head") {
        writeFileSync(join(root, "selected.json"), JSON.stringify(roster("brain", "b".repeat(40))));
      } else if (kind === "origin") {
        execFileSync("git", [
          "-C",
          join(root, "source"),
          "remote",
          "set-url",
          "origin",
          "https://github.com/fixture/other.git",
        ]);
      } else {
        writeFileSync(
          join(root, "source/skills/brain", kind === "dirty-skill" ? "SKILL.md" : "new-input.txt"),
          "changed bytes",
        );
      }
      expect(invoke(root, kind === "head" ? ["--roster", "selected.json"] : []).status).toBe(1);
      expect(existsSync(join(root, "output"))).toBe(false);
    },
  );

  it("refuses a committed skill-directory symlink outside the source checkout", () => {
    const root = fixture();
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, "source/skills/escaped"));
    execFileSync("git", ["-C", join(root, "source"), "add", "skills/escaped"]);
    execFileSync("git", [
      "-C",
      join(root, "source"),
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "synthetic escaping path",
    ]);
    const ref = execFileSync("git", ["-C", join(root, "source"), "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const selected = {
      ...roster("escaped", ref),
      skills: [{ key: "escaped", path: "skills/escaped" }],
    };
    writeFileSync(join(root, "selected.json"), JSON.stringify(selected));
    const result = invoke(root, ["--roster", "selected.json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("escapes the source checkout");
    expect(existsSync(join(root, "output"))).toBe(false);
  });

  it("ignores inherited Git routing variables when verifying the selected checkout", () => {
    const root = fixture();
    expect(
      invoke(root, [], { GIT_DIR: join(root, "absent.git"), GIT_WORK_TREE: join(root, "outside") })
        .status,
    ).toBe(0);
  });
  it("does not let a local replacement commit authenticate changed skill bytes under the original pin", () => {
    const root = fixture();
    const source = join(root, "source");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
    const original = sourceRef(root);
    writeFileSync(join(source, "skills/brain/SKILL.md"), "Replacement bytes, not the pinned skill");
    git("add", "skills/brain/SKILL.md");
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "synthetic replacement");
    const replacement = git("rev-parse", "HEAD");
    git("replace", original, replacement);
    git("checkout", "--detach", original);
    expect(git("rev-parse", "HEAD")).toBe(original);
    expect(git("status", "--porcelain")).toBe("");
    expect(readFileSync(join(source, "skills/brain/SKILL.md"), "utf8")).toBe(
      "Replacement bytes, not the pinned skill",
    );
    const result = invoke(root);
    expect(result.status).toBe(1);
    expect(existsSync(join(root, "output"))).toBe(false);
  });
});
