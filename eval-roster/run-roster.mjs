#!/usr/bin/env node
/**
 * eval-roster/run-roster.mjs — drive the nightly skill-eval roster.
 *
 * Reads eval-roster/roster.json, then for each listed skill runs THIS repo's
 * own workspace CLI (`packages/cli/dist/index.js eval …`) against the skill
 * directory in a read-only checkout of the roster source repo, emitting a
 * kernel-valid gate-result/v1 Statement bundle per skill plus the machine
 * summary the CI emitter (ci/emit-evidence/emit-evidence.ts) consumes.
 *
 * Per-skill failures do NOT abort the roster — a crashed eval is recorded as
 * an honest `status: "error"` row and becomes a gate_decision:"error" row in
 * the published evidence. The run only exits non-zero when EVERY skill fails
 * (harness-level failure, nothing worth publishing).
 *
 * Outputs under --out (default build/roster/):
 *   <key>.statements.json   — j-rig `--emit-bundle` output (in-toto Statements)
 *   <key>.result.json       — j-rig `--json` stdout (full report)
 *   <key>.error.log         — only on failure
 *   roster-summary.json     — one row per skill for the emitter
 *
 * Usage:
 *   node eval-roster/run-roster.mjs --src <roster-source-checkout> [--out build/roster]
 *     [--skills key1,key2] [--provider deepseek]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(repoRoot, "packages", "cli", "dist", "index.js");

function parseArgs(argv) {
  const args = {
    src: "",
    out: join(repoRoot, "build", "roster"),
    skills: null,
    provider: null,
    models: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src") args.src = argv[++i] ?? "";
    else if (argv[i] === "--out") args.out = argv[++i] ?? args.out;
    else if (argv[i] === "--skills") args.skills = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (argv[i] === "--provider") args.provider = argv[++i] ?? null;
    // Needed whenever --provider differs from the roster default: the specs pin
    // the DeepSeek model id, which other backends would 404 on.
    else if (argv[i] === "--models") args.models = argv[++i] ?? null;
  }
  return args;
}

function sha256HexOfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.src) {
    console.error("run-roster: --src <roster-source-checkout> is required");
    return 1;
  }
  if (!existsSync(CLI)) {
    console.error(`run-roster: workspace CLI not built (${CLI}) — run \`pnpm run build\` first`);
    return 1;
  }
  const roster = JSON.parse(readFileSync(join(repoRoot, "eval-roster", "roster.json"), "utf8"));
  const provider = args.provider ?? roster.provider;
  const skills = roster.skills.filter((s) => (args.skills ? args.skills.includes(s.key) : true));
  mkdirSync(args.out, { recursive: true });

  const summary = [];
  let ok = 0;
  for (const skill of skills) {
    const skillDir = join(args.src, skill.path);
    const specPath = join(skillDir, "eval-spec.yaml");
    const statementsPath = join(args.out, `${skill.key}.statements.json`);
    const resultPath = join(args.out, `${skill.key}.result.json`);
    const row = {
      key: skill.key,
      path: skill.path,
      status: "error",
      decisions: [],
      specSha256: null,
      skillsCommit: roster.source.ref,
      statementsFile: null,
    };
    try {
      if (!existsSync(join(skillDir, "SKILL.md"))) throw new Error(`no SKILL.md at ${skillDir}`);
      if (!existsSync(specPath)) throw new Error(`no eval-spec.yaml at ${skillDir}`);
      row.specSha256 = sha256HexOfFile(specPath);
      console.log(`\n=== ${skill.key} (provider: ${provider}) ===`);
      const stdout = execFileSync(
        process.execPath,
        [
          CLI,
          "eval",
          skillDir,
          "--provider",
          provider,
          "--spec",
          specPath,
          "--samples",
          String(roster.samples),
          ...(args.models ? ["--models", args.models] : []),
          "--run-self-test",
          "--emit-bundle",
          statementsPath,
          "--db",
          join(args.out, "j-rig.db"),
          "--json",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 20 * 60 * 1000 },
      );
      writeFileSync(resultPath, stdout, "utf8");
      const statements = JSON.parse(readFileSync(statementsPath, "utf8"));
      row.decisions = statements.map((st) => st?.predicate?.gate_decision ?? "error");
      row.statementsFile = `${skill.key}.statements.json`;
      row.status = "ok";
      ok += 1;
      console.log(`--- ${skill.key}: ${row.decisions.join(", ")}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeFileSync(join(args.out, `${skill.key}.error.log`), msg, "utf8");
      console.error(`--- ${skill.key}: ERROR — ${msg.slice(0, 300)}`);
    }
    summary.push(row);
  }

  writeFileSync(join(args.out, "roster-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`\nroster complete: ${ok}/${skills.length} skills evaluated cleanly`);
  if (ok === 0) {
    console.error("run-roster: every skill failed — nothing worth publishing (fail-closed)");
    return 1;
  }
  return 0;
}

process.exit(main());
