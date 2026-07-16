#!/usr/bin/env -S node --experimental-strip-types
/**
 * ci/emit-evidence/emit-evidence.ts — shape the nightly skill-eval roster
 * results into signed-ready evidence for the intent-eval-dashboard reports hub
 * (labs.intentsolutions.io, repo row key `jrig`).
 *
 * ── Why this lives in `ci/emit-evidence/`, NOT a workspace package ──
 *
 * This emitter is a CI-only artifact producer with its own pinned dependency
 * (`@intentsolutions/core` — the kernel validators, pinned to the EXACT
 * version the dashboard verifies with). It has its own private, non-workspace
 * `package.json` + lockfile so the published workspace packages are untouched.
 * Nothing under `ci/` ships anywhere. The pattern (and the canonicalisation
 * contract) mirrors the proven ccp emitter in claude-code-plugins.
 *
 * ── What it attests (honest, no fake evidence) ──
 *
 * One gate-result/v1 row PER ROSTER SKILL, derived from the nightly behavioral
 * eval that eval-roster/run-roster.mjs just ran with this repo's own CLI
 * (`j-rig eval … --provider deepseek`). The decision is copied from the
 * kernel-valid Statement bundle the CLI emitted (ship → pass, block → fail,
 * advisory stays advisory); a crashed eval becomes an honest
 * `gate_decision: "error"` row rather than being dropped. The policy a row
 * attests under IS the skill's hand-authored eval-spec.yaml — `policy_hash` is
 * the sha256 of the spec bytes at the pinned roster-source commit, so any
 * auditor can recompute it from the tree.
 *
 * Inputs (produced by eval-roster/run-roster.mjs):
 *   build/roster/roster-summary.json
 *   build/roster/<key>.statements.json
 *
 * Outputs:
 *   build/evidence/bundle-<i>.json          — CANONICAL EvidenceBundle bytes
 *   build/evidence/gate-result-<i>.json     — the gate-result/v1 predicate body
 *   build/evidence/manifest-skeleton.json   — for ci/emit-evidence/assemble-manifest.ts
 *
 * Signing + Rekor + final report-manifest.json assembly happen in CI
 * (.github/workflows/nightly-skill-evals.yml). This script does NO crypto and
 * writes only to the gitignored `build/` dir.
 *
 * Usage:
 *   node --experimental-strip-types ci/emit-evidence/emit-evidence.ts \
 *     [--roster build/roster] [--out build/evidence] [--ref refs/heads/main] [--self-check]
 */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  GateResultV1Schema,
  GATE_RESULT_V1_URI,
} from "@intentsolutions/core/validators/v1/gate-result-v1";
import { EvidenceBundleSchema } from "@intentsolutions/core/validators/v1/evidence-bundle";

const GITHUB_REPO = "jeremylongshore/j-rig-skill-binary-eval";
const REPO_KEY = "jrig";
const WORKFLOW_FILE = "nightly-skill-evals.yml";

interface RosterRow {
  readonly key: string;
  readonly path: string;
  readonly status: "ok" | "error";
  readonly decisions: readonly string[];
  readonly specSha256: string | null;
  readonly skillsCommit: string;
  readonly statementsFile: string | null;
}

interface GateOutcome {
  readonly gateName: string;
  readonly gateVersion: string;
  readonly decision: "pass" | "fail" | "advisory" | "error";
  readonly reasons: readonly string[];
  readonly dimensionsEvaluated: readonly string[];
  readonly dimensionsSkipped: readonly string[];
  readonly specSha256: string;
  readonly skillPath: string;
  readonly skillsCommit: string;
  readonly advisorySeverity?: "info" | "warn" | "error";
  readonly failureMode?: string;
}

interface EmitContext {
  readonly nowIso: string;
  readonly nowMs: number;
  readonly sourceSha: string;
  readonly runnerVersion: string;
  readonly rand16: () => Uint8Array;
}

// ── Canonicalisation (MUST match the dashboard's content-address.ts) ──

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortDeep(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/** Canonical JSON string (sorted keys, no whitespace) — dashboard-identical. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

/** Generate a kernel-valid UUIDv7 from a 16-byte source + ms timestamp. */
export function uuidv7(nowMs: number, rand: Uint8Array): string {
  const b = Buffer.from(rand.slice(0, 16));
  const ts = BigInt(nowMs);
  b[0] = Number((ts >> 40n) & 0xffn);
  b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn);
  b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);
  b[5] = Number(ts & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A built row: the kernel-valid bundle + its canonical bytes + the gate body. */
export interface EmitRow {
  readonly bundle: unknown;
  readonly canonicalBundle: string;
  readonly gateResult: unknown;
  readonly sourceSha: string;
}

/**
 * Build + kernel-validate a gate-result/v1 body for one roster outcome. Throws
 * (fail closed) if the result is not kernel-schema-valid.
 */
export function buildGateResult(o: GateOutcome, ctx: EmitContext): Record<string, unknown> {
  const gateId = `${REPO_KEY}:ci:${o.gateName}`;
  const policyHash = `sha256:${o.specSha256}`;
  const inputHash = `sha256:${sha256Hex(`${o.skillsCommit}:${o.gateName}:${policyHash}`)}`;
  const body: Record<string, unknown> = {
    gate_id: gateId,
    gate_name: o.gateName,
    gate_version: o.gateVersion,
    gate_decision: o.decision,
    gate_reasons: [...o.reasons],
    coverage: {
      dimensions_evaluated: [...o.dimensionsEvaluated],
      dimensions_skipped: [...o.dimensionsSkipped],
    },
    policy_ref: `${policyHash}:${o.skillPath}/eval-spec.yaml@${o.skillsCommit.slice(0, 12)}`,
    policy_hash: policyHash,
    input_hash: inputHash,
    evaluated_at: ctx.nowIso,
    runner: `jrig-nightly@${ctx.runnerVersion}`,
    commit_sha: o.skillsCommit,
    ...(o.advisorySeverity !== undefined ? { advisory_severity: o.advisorySeverity } : {}),
    ...(o.failureMode !== undefined ? { failure_mode: o.failureMode } : {}),
  };
  GateResultV1Schema.parse(body); // fail-closed
  return body;
}

/**
 * Wrap a gate-result body in a kernel EvidenceBundle. Throws if the bundle is
 * not kernel-schema-valid.
 */
export function buildEvidenceBundle(
  gateResult: Record<string, unknown>,
  ctx: EmitContext,
): Record<string, unknown> {
  const grHashHex = sha256Hex(stableStringify(gateResult));
  const inputHash = String(gateResult["input_hash"]);
  const subjectDigest = inputHash.startsWith("sha256:")
    ? inputHash.slice("sha256:".length)
    : inputHash;
  const bundle: Record<string, unknown> = {
    id: uuidv7(ctx.nowMs, ctx.rand16()),
    eval_run_id: uuidv7(ctx.nowMs, ctx.rand16()),
    created_at: ctx.nowIso,
    predicate_uri_set: [GATE_RESULT_V1_URI],
    row_count: 1,
    subject_set: [{ name: String(gateResult["gate_id"]), digest: { sha256: subjectDigest } }],
    storage_key: `sha256:${grHashHex}`,
    signing_mode: "rekor_production",
    rekor_log_indices: [], // real index lives in the sigstore Bundle
    verification_status: "unverified", // the dashboard re-verifies; we don't self-attest
    verification_last_checked_at: ctx.nowIso,
  };
  EvidenceBundleSchema.parse(bundle); // fail-closed
  return bundle;
}

/** Build all rows from outcomes. */
export function buildRows(outcomes: readonly GateOutcome[], ctx: EmitContext): EmitRow[] {
  return outcomes.map((o) => {
    const gateResult = buildGateResult(o, ctx);
    const bundle = buildEvidenceBundle(gateResult, ctx);
    return {
      bundle,
      canonicalBundle: stableStringify(bundle),
      gateResult,
      sourceSha: ctx.sourceSha,
    };
  });
}

/** The manifest skeleton CI signs + assembles into the final report-manifest.json. */
export interface ManifestSkeleton {
  readonly repo: string;
  readonly signing: {
    readonly issuer: string;
    readonly subject: string;
    readonly workflowRef: string;
  };
  readonly rows: readonly {
    readonly bundleFile: string;
    readonly gateResults: readonly unknown[];
    readonly sourceSha: string;
  }[];
}

/**
 * The OIDC signing claims this CI run will assert. The nightly workflow runs
 * on schedule (default branch) plus a main-only dispatch guard, so `ref` is
 * always `refs/heads/main` in CI — exactly the claims the dashboard pins for
 * the `jrig` row.
 */
export function signingClaims(ref: string): ManifestSkeleton["signing"] {
  return {
    issuer: "https://token.actions.githubusercontent.com",
    subject: `repo:${GITHUB_REPO}:ref:${ref}`,
    workflowRef: `${GITHUB_REPO}/.github/workflows/${WORKFLOW_FILE}@${ref}`,
  };
}

/** Write all emit artifacts under `outDir`. Returns the skeleton written. */
export function writeEmit(rows: readonly EmitRow[], ref: string, outDir: string): ManifestSkeleton {
  mkdirSync(outDir, { recursive: true });
  const skeletonRows = rows.map((row, i) => {
    const bundleFile = `bundle-${i}.json`;
    writeFileSync(join(outDir, bundleFile), row.canonicalBundle, "utf8");
    writeFileSync(join(outDir, `gate-result-${i}.json`), stableStringify(row.gateResult), "utf8");
    return { bundleFile, gateResults: [row.gateResult], sourceSha: row.sourceSha };
  });
  const skeleton: ManifestSkeleton = {
    repo: REPO_KEY,
    signing: signingClaims(ref),
    rows: skeletonRows,
  };
  writeFileSync(join(outDir, "manifest-skeleton.json"), JSON.stringify(skeleton, null, 2), "utf8");
  return skeleton;
}

// ── Outcome collection (reads the roster runner's outputs) ──

/** Aggregate a statement-decision list into one gate decision. */
export function aggregateDecision(
  decisions: readonly string[],
): "pass" | "fail" | "advisory" | "error" {
  if (decisions.length === 0) return "error";
  if (decisions.some((d) => d === "error")) return "error";
  if (decisions.some((d) => d === "fail")) return "fail";
  if (decisions.some((d) => d === "advisory")) return "advisory";
  if (decisions.every((d) => d === "pass")) return "pass";
  return "error";
}

interface StatementPredicate {
  readonly gate_reasons?: readonly string[];
  readonly metadata?: {
    readonly provider?: string;
    readonly ground_truth?: boolean;
    readonly model?: string;
    readonly passed?: number;
    readonly total_criteria?: number;
  };
}

/**
 * Read a roster row's Statement bundle and derive human reasons. Fail-closed
 * stub refusal: j-rig's stub provider marks its output `ground_truth: false` /
 * `provider: "stub"`, and stub rows must NEVER become signed evidence — the
 * whole emit aborts rather than laundering placeholder verdicts.
 */
function statementReasons(rosterDir: string, row: RosterRow): string[] {
  if (row.statementsFile === null) return [];
  const statements = JSON.parse(
    readFileSync(join(rosterDir, row.statementsFile), "utf8"),
  ) as readonly { predicate?: StatementPredicate }[];
  const reasons: string[] = [];
  for (const st of statements) {
    const meta = st.predicate?.metadata;
    if (meta?.provider === "stub" || meta?.ground_truth === false) {
      throw new Error(
        `${row.key}: statements were produced under STUB mode (ground_truth:false) — refusing to emit signed evidence from placeholder verdicts`,
      );
    }
    if (typeof meta?.passed === "number" && typeof meta?.total_criteria === "number") {
      reasons.push(
        `${meta.passed}/${meta.total_criteria} criteria passed on ${meta.model ?? "unknown-model"} (provider: ${meta.provider ?? "unknown"})`,
      );
    }
    for (const r of st.predicate?.gate_reasons ?? []) reasons.push(String(r).slice(0, 300));
  }
  return reasons.slice(0, 6);
}

export function collectOutcomes(rosterDir: string): GateOutcome[] {
  const summaryPath = join(rosterDir, "roster-summary.json");
  if (!existsSync(summaryPath)) {
    throw new Error(`missing ${summaryPath} — run eval-roster/run-roster.mjs first`);
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as readonly RosterRow[];
  if (summary.length === 0) throw new Error("roster summary is empty");
  return summary.map((row) => {
    const evalFailed = row.status !== "ok" || row.specSha256 === null;
    const decision = evalFailed ? "error" : aggregateDecision(row.decisions);
    const reasons = evalFailed
      ? [`nightly eval did not complete for ${row.key} (see ${row.key}.error.log in the run)`]
      : statementReasons(rosterDir, row);
    const outcome: GateOutcome = {
      gateName: row.key,
      gateVersion: "1.0.0",
      decision,
      reasons: reasons.length > 0 ? reasons : [`behavioral eval decision: ${decision}`],
      dimensionsEvaluated: evalFailed ? [] : ["trigger-behavior", "functional-criteria"],
      dimensionsSkipped: evalFailed ? ["trigger-behavior", "functional-criteria"] : [],
      specSha256: row.specSha256 ?? "0".repeat(64),
      skillPath: row.path,
      skillsCommit: row.skillsCommit,
      ...(decision === "advisory" ? { advisorySeverity: "warn" as const } : {}),
      ...(decision === "fail" ? { failureMode: "behavioral-eval-block" } : {}),
      ...(decision === "error" ? { failureMode: "eval-runner-error" } : {}),
    };
    return outcome;
  });
}

// ── Self-check (locally-runnable correctness proof) ──

function selfCheck(): void {
  const ctx = synthCtx();
  const outcomes: GateOutcome[] = [
    {
      gateName: "example-skill-pass",
      gateVersion: "1.0.0",
      decision: "pass",
      reasons: ["all 17 criteria passed on deepseek-v4-flash"],
      dimensionsEvaluated: ["trigger-behavior", "functional-criteria"],
      dimensionsSkipped: [],
      specSha256: "c".repeat(64),
      skillPath: "plugins/saas-packs/example/skills/example-skill-pass",
      skillsCommit: "a".repeat(40),
    },
    {
      gateName: "example-skill-error",
      gateVersion: "1.0.0",
      decision: "error",
      reasons: ["nightly eval did not complete for example-skill-error"],
      dimensionsEvaluated: [],
      dimensionsSkipped: ["trigger-behavior", "functional-criteria"],
      specSha256: "0".repeat(64),
      skillPath: "plugins/saas-packs/example/skills/example-skill-error",
      skillsCommit: "a".repeat(40),
      failureMode: "eval-runner-error",
    },
  ];
  const rows = buildRows(outcomes, ctx); // throws if any artifact is kernel-invalid
  for (const row of rows) {
    if (stableStringify(JSON.parse(row.canonicalBundle)) !== row.canonicalBundle) {
      throw new Error("canonical bundle is not stable under re-canonicalisation");
    }
  }
  if (rows.length !== 2) throw new Error("expected 2 rows");
  const agg = [
    aggregateDecision(["pass", "pass"]) === "pass",
    aggregateDecision(["pass", "fail"]) === "fail",
    aggregateDecision(["advisory", "pass"]) === "advisory",
    aggregateDecision([]) === "error",
  ];
  if (!agg.every(Boolean)) throw new Error("aggregateDecision self-check failed");
  console.log(`self-check OK: ${rows.length} kernel-valid, canonical-stable rows built`);
}

function synthCtx(): EmitContext {
  let n = 0;
  return {
    nowIso: "2026-07-16T00:00:00.000Z",
    nowMs: 1783900800000,
    sourceSha: "a".repeat(40),
    runnerVersion: "0.1.0",
    // Deterministic, non-random 16-byte source so self-check output is stable.
    rand16: () => {
      n += 1;
      return Uint8Array.from(Array.from({ length: 16 }, (_v, i) => (n * 31 + i) & 0xff));
    },
  };
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "0".repeat(40);
  }
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "ci", "emit-evidence", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function ciCtx(): EmitContext {
  return {
    nowIso: new Date().toISOString(),
    nowMs: Date.now(),
    sourceSha: gitSha(),
    runnerVersion: packageVersion(),
    rand16: () => Uint8Array.from(randomBytes(16)),
  };
}

function parseArgs(argv: readonly string[]): {
  roster: string;
  out: string;
  ref: string;
  selfCheck: boolean;
} {
  let roster = "build/roster";
  let out = "build/evidence";
  let ref = process.env["GITHUB_REF"] ?? "refs/heads/main";
  let sc = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--roster") {
      roster = argv[i + 1] ?? roster;
      i++;
    } else if (argv[i] === "--out") {
      out = argv[i + 1] ?? out;
      i++;
    } else if (argv[i] === "--ref") {
      ref = argv[i + 1] ?? ref;
      i++;
    } else if (argv[i] === "--self-check") {
      sc = true;
    }
  }
  return { roster, out, ref, selfCheck: sc };
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.selfCheck) {
    selfCheck();
    return 0;
  }
  const ctx = ciCtx();
  const outcomes = collectOutcomes(args.roster);
  const rows = buildRows(outcomes, ctx);
  writeEmit(rows, args.ref, args.out);
  console.log(
    `emit-evidence OK: ${rows.length} kernel-valid gate-result/v1 row(s) written to ${args.out}\n` +
      `  decisions: ${outcomes.map((o) => `${o.gateName}=${o.decision}`).join(", ")}\n` +
      `  next (CI): cosign sign-blob each bundle-<i>.json -> assemble-manifest.ts -> report-manifest.json`,
  );
  return 0;
}

// Only run when invoked directly (not when imported by a sibling assembler).
const invokedDirectly = process.argv[1]?.endsWith("emit-evidence.ts") === true;
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error(
      "emit-evidence FAILED (fail-closed):",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}
