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
 *     [--roster path/to/roster.json] [--skills key1,key2] [--provider minimax] [--models MiniMax-M3]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(repoRoot, "packages", "cli", "dist", "index.js");
export const SKILL_TIMEOUT_MS = 20 * 60 * 1000;
export const EVIDENCE_RESERVE_MINUTES = 20;

/** Initial budget only: never replay an empty, already completed response. */
export function executionEnvironment(provider, models, env = process.env) {
  if (
    provider === "minimax" &&
    models === "MiniMax-M3" &&
    !env.JRIG_MAX_OUTPUT_TOKENS &&
    !env.LLM_MODEL &&
    !env.LLM_BASE_URL
  ) {
    return { ...env, JRIG_MAX_OUTPUT_TOKENS: "16384" };
  }
  return { ...env };
}

function parseArgs(argv) {
  const args = {
    src: "",
    roster: join(repoRoot, "eval-roster", "roster.json"),
    out: join(repoRoot, "build", "roster"),
    skills: null,
    provider: null,
    models: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src") args.src = argv[++i] ?? "";
    else if (argv[i] === "--roster") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--roster requires a file path");
      args.roster = resolve(value);
    } else if (argv[i] === "--out") args.out = argv[++i] ?? args.out;
    else if (argv[i] === "--skills") args.skills = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (argv[i] === "--provider") args.provider = argv[++i] ?? null;
    // Needed whenever --provider differs from the roster default: the specs pin
    // provider-specific model ids, which other backends may reject.
    else if (argv[i] === "--models") args.models = argv[++i] ?? null;
  }
  return args;
}

function sha256HexOfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Read gate_reasons[0] from the `error` row j-rig wrote before exiting 2.
 * Returns null unless EVERY row is an `error` verdict with a
 * `provider_failure/` class-first reason, so nothing else can ride into the
 * nightly's signed evidence through this path.
 */
export function infrastructureFailureReason(statementsPath) {
  try {
    if (!existsSync(statementsPath)) return null;
    const statements = JSON.parse(readFileSync(statementsPath, "utf8"));
    if (!Array.isArray(statements) || statements.length === 0) return null;
    const reasons = statements.map((st) =>
      st?.predicate?.gate_decision === "error" ? st?.predicate?.gate_reasons?.[0] : undefined,
    );
    if (!reasons.every((r) => typeof r === "string" && r.startsWith("provider_failure/"))) {
      return null;
    }
    return reasons[0].slice(0, 400);
  } catch {
    return null;
  }
}

/**
 * Per-row headroom status from a skill's signed statements (000-docs/043):
 * one entry per model row, `null` where a row carries no headroom (an `error`
 * row has no verdict and so no headroom claim). Reported beside the decision,
 * never folded into it.
 */
export function headroomStatuses(statements) {
  if (!Array.isArray(statements)) return [];
  return statements.map((st) => {
    const status = st?.predicate?.metadata?.headroom?.status;
    return typeof status === "string" ? status : null;
  });
}

/** Admit configured paths before any output or evaluator subprocess. */
export function loadRoster(path) {
  const roster = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof roster?.source?.ref !== "string" ||
    !/^[0-9a-f]{40}(?![\s\S])/.test(roster.source.ref)
  ) {
    throw new Error("roster.source.ref must be a full 40-hex commit SHA");
  }
  if (
    typeof roster.source.githubRepo !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/.test(roster.source.githubRepo)
  ) {
    throw new Error("roster.source.githubRepo must identify a GitHub owner/repository");
  }
  if (typeof roster.provider !== "string" || !roster.provider.trim()) {
    throw new Error("roster.provider must be nonempty");
  }
  if (roster.models !== undefined && (typeof roster.models !== "string" || !roster.models.trim())) {
    throw new Error("roster.models must be nonempty when provided");
  }
  if (!Number.isInteger(roster.samples) || roster.samples < 1 || roster.samples > 25) {
    throw new Error("roster.samples must be an integer from 1 through 25");
  }
  if (!Array.isArray(roster.skills) || !roster.skills.length) {
    throw new Error("roster.skills must be nonempty");
  }
  const keys = new Set();
  for (const skill of roster.skills) {
    if (
      typeof skill?.key !== "string" ||
      !/^[a-z0-9][a-z0-9-]*(?![\s\S])/.test(skill.key) ||
      keys.has(skill.key)
    ) {
      throw new Error("roster skill keys must be unique safe filenames");
    }
    keys.add(skill.key);
    if (
      typeof skill.path !== "string" ||
      skill.path.includes("\\") ||
      skill.path.includes("\0") ||
      skill.path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("roster skill paths must be confined relative paths");
    }
  }
  return roster;
}

function sourceGit(root, args) {
  try {
    return execFileSync("git", ["--no-replace-objects", "-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
    }).trim();
  } catch {
    // Git diagnostics can contain credentialed remotes; never print them.
    throw new Error("source checkout Git verification failed");
  }
}

function githubIdentity(remote) {
  const scp = /^git@github\.com:([^\s]+)(?![\s\S])/.exec(remote);
  if (scp) return scp[1].replace(/\.git$/, "").toLowerCase();
  try {
    const url = new URL(remote);
    if (url.hostname !== "github.com" || !["https:", "ssh:"].includes(url.protocol)) return null;
    if (url.search || url.hash) return null;
    return url.pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

function confinedPath(root, path) {
  const actual = realpathSync(path);
  const rel = relative(root, actual);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("selected skill path escapes the source checkout");
  }
  return actual;
}

/** Bind the advertised pin to a clean local checkout; no remote requests. */
export function verifySourceCheckout(src, roster, skills) {
  const root = realpathSync(src);
  if (sourceGit(root, ["rev-parse", "--show-toplevel"]) !== root) {
    throw new Error("--src must be the source checkout root");
  }
  if (sourceGit(root, ["rev-parse", "HEAD"]) !== roster.source.ref) {
    throw new Error("source checkout HEAD differs from roster.source.ref");
  }
  if (
    githubIdentity(sourceGit(root, ["remote", "get-url", "origin"])) !==
    roster.source.githubRepo.toLowerCase()
  ) {
    throw new Error("source checkout origin differs from roster.source.githubRepo");
  }
  for (const skill of skills) {
    const dir = confinedPath(root, join(root, skill.path));
    if (!statSync(dir).isDirectory()) throw new Error("selected skill is not a directory");
    if (
      sourceGit(root, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        skill.path,
        relative(root, dir),
      ])
    ) {
      throw new Error("selected skill checkout contains uncommitted changes");
    }
    for (const name of ["SKILL.md", "eval-spec.yaml"]) {
      const file = confinedPath(root, join(dir, name));
      if (!statSync(file).isFile()) throw new Error("selected skill input is not a regular file");
      const actualBlob = sourceGit(root, ["hash-object", "--no-filters", file]);
      if (actualBlob !== sourceGit(root, ["rev-parse", `HEAD:${relative(root, file)}`])) {
        throw new Error("selected skill bytes differ from the pinned commit");
      }
    }
  }
  return root;
}

function main() {
  let args;
  let roster;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!args.src) throw new Error("--src <roster-source-checkout> is required");
    roster = loadRoster(args.roster);
  } catch (err) {
    console.error(`run-roster: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!existsSync(CLI)) {
    console.error(`run-roster: workspace CLI not built (${CLI}) — run \`pnpm run build\` first`);
    return 1;
  }
  const provider = args.provider ?? roster.provider;
  // Model precedence: --models flag > roster.models > the spec's own models
  // list. roster.models exists because the specs pin a provider-specific model
  // id; it is PAIRED with roster.provider, so it only applies when the
  // effective provider IS the roster's (a --provider override without
  // --models falls back to the spec's own model list).
  const rosterProvider = String(roster.provider ?? "")
    .trim()
    .toLowerCase();
  const effectiveProvider = String(provider ?? "")
    .trim()
    .toLowerCase();
  const models =
    args.models ?? (effectiveProvider === rosterProvider ? (roster.models ?? null) : null);
  const skills = roster.skills.filter((s) => (args.skills ? args.skills.includes(s.key) : true));
  try {
    args.src = verifySourceCheckout(args.src, roster, skills);
  } catch (err) {
    console.error(`run-roster: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const executionEnv = executionEnvironment(effectiveProvider, models);
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
      errorReason: null,
      headroom: [],
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
          ...(models ? ["--models", models] : []),
          "--run-self-test",
          // Unreviewed `scaffold-spec --draft` output must never gate a nightly.
          "--require-reviewed",
          "--emit-bundle",
          statementsPath,
          "--db",
          join(args.out, "j-rig.db"),
          "--json",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
          timeout: SKILL_TIMEOUT_MS,
          env: executionEnv,
        },
      );
      writeFileSync(resultPath, stdout, "utf8");
      const statements = JSON.parse(readFileSync(statementsPath, "utf8"));
      row.decisions = Array.isArray(statements)
        ? statements.map((st) => st?.predicate?.gate_decision ?? "error")
        : [];
      row.headroom = headroomStatuses(statements);
      row.statementsFile = `${skill.key}.statements.json`;
      row.status = "ok";
      ok += 1;
      console.log(
        `--- ${skill.key}: ${row.decisions.join(", ")} (headroom: ${row.headroom.map((h) => h ?? "n/a").join(", ")})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Exit 2 is j-rig's evaluator-infrastructure-failure contract
      // (000-docs/037): the CLI still wrote a kernel-valid `error` row whose
      // gate_reasons[0] names the failure class. execFileSync throws on any
      // non-zero exit, so without this the row was discarded and the nightly
      // published a generic "did not complete" reason instead. Carry the
      // CLI's own, already-redacted reason forward; the row stays an error.
      if (err && typeof err === "object" && err.status === 2) {
        row.errorReason = infrastructureFailureReason(statementsPath);
        if (typeof err.stdout === "string") writeFileSync(resultPath, err.stdout, "utf8");
      }
      writeFileSync(join(args.out, `${skill.key}.error.log`), msg, "utf8");
      console.error(`--- ${skill.key}: ERROR — ${msg.slice(0, 300)}`);
    }
    summary.push(row);
  }

  writeFileSync(join(args.out, "roster-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`\nroster complete: ${ok}/${skills.length} skills evaluated cleanly`);
  const saturated = summary.filter((r) => r.headroom.includes("saturated")).map((r) => r.key);
  const saturationLine =
    saturated.length === 0
      ? "saturated evals: none"
      : `saturated evals (cannot show improvement): ${saturated.join(", ")}`;
  console.log(saturationLine);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**Roster headroom:** ${saturationLine}\n`);
  }
  if (ok === 0) {
    console.error("run-roster: every skill failed — nothing worth publishing (fail-closed)");
    return 1;
  }
  return 0;
}

// Run only as a script, so the helpers above can be imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
