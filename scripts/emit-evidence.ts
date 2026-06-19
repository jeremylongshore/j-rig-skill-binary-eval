#!/usr/bin/env -S node --experimental-strip-types
/**
 * emit-evidence.ts — produce j-rig's own signed-ready testing evidence for the
 * intent-eval-dashboard reports hub (bead nr75.11: "Emit a signed
 * report-manifest of gate-result/v1 rows from j-rig CI and flip its dashboard
 * row").
 *
 * This is the DETERMINISTIC half of the emit. It runs j-rig's real deterministic
 * gate(s), shapes each outcome into a kernel `gate-result/v1` body, wraps each in
 * a kernel `EvidenceBundle`, and writes:
 *
 *   build/evidence/bundle-<i>.json          — the CANONICAL EvidenceBundle bytes
 *                                             (exactly what the dashboard
 *                                             re-canonicalises + the signature
 *                                             covers; CI runs `cosign sign-blob`
 *                                             over THIS file)
 *   build/evidence/gate-result-<i>.json     — the gate-result/v1 predicate body
 *   build/evidence/manifest-skeleton.json   — repo + signing claims + per-row
 *                                             {bundleFile, gateResults, sourceSha}
 *                                             for scripts/assemble-manifest.ts
 *
 * The signing + Rekor anchoring + final `report-manifest.json` assembly + publish
 * happen in CI (`.github/workflows/release.yml` emit-evidence job) — see that
 * file. This script does NO crypto and writes only to the gitignored `build/` dir.
 *
 * ── Gate selection (honest, no fake evidence) ──
 *
 * j-rig's only deterministic gate that yields REAL, non-degraded, release-state
 * signal AND has an authored teaching explainer on the dashboard is COVERAGE.
 * The others were deliberately EXCLUDED after recon rather than emitted as token
 * rows (which would be fake evidence — the shortcut the nr75 plan refuses):
 *   - architecture — `audit-harness arch` reports `tool=none / not-configured`
 *     (no rule pack for j-rig); emitting pass/fail would misrepresent.
 *   - crap         — `audit-harness crap` runs degraded ("complexity-report not
 *     installed"), skipping all TS; not real signal.
 *   - escape-scan  — a DIFF gate (--staged/--range), not a release-state gate.
 *   - mutation     — not run in this repo.
 * Wiring any of these as real gates is a separate follow-up, not this task.
 *
 * Coverage decision is honest about j-rig's policy: vitest.config.ts declares NO
 * coverage floor, so the gate emits `advisory` carrying the measured percentages
 * (no unfounded pass/fail). If a floor is ever declared (`lines: N` in
 * vitest.config.ts) the gate flips to pass/fail against it — so this generalises
 * unchanged to repos that DO declare a floor.
 *
 * ── Contract (matches the dashboard ingest, verified against its source) ──
 *
 *   - Each `bundle` validates against `EvidenceBundleSchema`.
 *   - The canonical bytes use the dashboard's `stableStringify` (sorted keys,
 *     no whitespace) so `cosign sign-blob`'s signature round-trips through the
 *     dashboard's `canonicalJsonBytes(row.bundle)` re-canonicalisation.
 *   - `signing_mode: 'rekor_production'` with `rekor_log_indices: []` in the
 *     SIGNED bundle: the real Rekor index lives in the sigstore Bundle's
 *     inclusion proof (which the dashboard's step-3 Rekor check verifies).
 *   - The gate-result/v1 bodies travel alongside each row (`gateResults`) for the
 *     dashboard's gate-row resolver; their content hash is recorded in the
 *     bundle `subject_set`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/emit-evidence.ts [--out build/evidence] [--self-check]
 *
 * Requires `pnpm run build` first (vitest coverage runs the workspace tests).
 * `--self-check` runs the builders over synthetic outcomes and asserts every
 * artifact is kernel-valid + canonical-stable, then exits — the locally-runnable
 * correctness proof.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  GateResultV1Schema,
  GATE_RESULT_V1_URI,
} from "@intentsolutions/core/validators/v1/gate-result-v1";
import { EvidenceBundleSchema } from "@intentsolutions/core/validators/v1/evidence-bundle";

const GITHUB_REPO = "jeremylongshore/j-rig-skill-binary-eval";
const REPO_KEY = "iaj";

/** A gate outcome, the input to the gate-result builder. */
interface GateOutcome {
  readonly gateName: string;
  readonly gateVersion: string;
  readonly decision: "pass" | "fail" | "advisory" | "error";
  readonly reasons: readonly string[];
  readonly dimensionsEvaluated: readonly string[];
  readonly dimensionsSkipped: readonly string[];
  readonly advisorySeverity?: "info" | "warn" | "error";
  readonly failureMode?: string;
}

/** Build context — everything non-deterministic is injected so tests are stable. */
interface EmitContext {
  readonly nowIso: string;
  readonly nowMs: number;
  readonly commitSha: string;
  readonly sourceSha: string;
  readonly policyHash: string;
  /** Emit-tool version (semver) for the gate-result `runner` field. */
  readonly runnerVersion: string;
  /** Deterministic UUID source: returns 16 random-ish bytes per call. */
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
 * Build + kernel-validate a gate-result/v1 body for one outcome. Throws (fail
 * closed) if the result is not kernel-schema-valid.
 */
export function buildGateResult(o: GateOutcome, ctx: EmitContext): Record<string, unknown> {
  const gateId = `${REPO_KEY}:ci:${o.gateName}`;
  // input_hash = the thing the gate evaluated. We hash the repo's policy + gate
  // identity as a stable, declared input digest (the gate evaluated this repo at
  // this commit under this policy). MUST be sha256:-prefixed per the schema.
  const inputHash = `sha256:${sha256Hex(`${ctx.commitSha}:${o.gateName}:${ctx.policyHash}`)}`;
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
    policy_ref: `${ctx.policyHash}:vitest.config.ts`,
    policy_hash: ctx.policyHash,
    input_hash: inputHash,
    evaluated_at: ctx.nowIso,
    runner: `j-rig-emit@${ctx.runnerVersion}`,
    commit_sha: ctx.commitSha,
    ...(o.advisorySeverity !== undefined ? { advisory_severity: o.advisorySeverity } : {}),
    ...(o.failureMode !== undefined ? { failure_mode: o.failureMode } : {}),
  };
  // Fail closed: a malformed gate-result must never be emitted.
  GateResultV1Schema.parse(body);
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
  const grCanonical = stableStringify(gateResult);
  const grHashHex = sha256Hex(grCanonical);
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
    rekor_log_indices: [], // real index lives in the sigstore Bundle (see header)
    verification_status: "unverified", // the dashboard re-verifies; we don't self-attest
    verification_last_checked_at: ctx.nowIso,
  };
  EvidenceBundleSchema.parse(bundle);
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

/** Compute the OIDC signing claims this CI run will assert (tag-derived). */
export function signingClaims(ref: string): ManifestSkeleton["signing"] {
  // ref e.g. refs/tags/v1.2.0  → subject repo:...:ref:refs/tags/v1.2.0
  return {
    issuer: "https://token.actions.githubusercontent.com",
    subject: `repo:${GITHUB_REPO}:ref:${ref}`,
    workflowRef: `${GITHUB_REPO}/.github/workflows/release.yml@${ref}`,
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

// ── Gate collection (CI-run; runs the repo's real gates) ──

function run(cmd: string, args: readonly string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args as string[], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}` };
  }
}

const COVERAGE_DIMENSIONS = ["lines", "branches", "functions", "statements"] as const;

/**
 * Run coverage (vitest json-summary) → one outcome.
 *
 * If a floor is declared in vitest.config.ts (`lines: N`) the decision is
 * pass/fail against it. j-rig declares NO floor, so the decision is `advisory`
 * carrying the measured percentages — honest, no unfounded pass/fail.
 */
function coverageOutcome(outDir: string): GateOutcome {
  const summaryPath = join(outDir, "coverage-summary.json");
  const r = run("pnpm", [
    "exec",
    "vitest",
    "run",
    "--coverage",
    "--coverage.reporter=json-summary",
    `--coverage.reportsDirectory=${outDir}`,
  ]);
  if (!existsSync(summaryPath)) {
    return {
      gateName: "coverage",
      gateVersion: "1.0.0",
      decision: "error",
      reasons: [
        `coverage summary not produced: ${firstLines(r.out, 4) || "vitest coverage run failed"}`,
      ],
      dimensionsEvaluated: [],
      dimensionsSkipped: [...COVERAGE_DIMENSIONS],
    };
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    total: Record<string, { pct: number }>;
  };
  const pct = (d: string): number => summary.total[d]?.pct ?? 0;
  const floor = coverageFloor();
  if (floor === null) {
    // No declared floor → advisory with the measured numbers (no pass/fail claim).
    return {
      gateName: "coverage",
      gateVersion: "1.0.0",
      decision: "advisory",
      advisorySeverity: "info",
      reasons: [
        ...COVERAGE_DIMENSIONS.map((d) => `${d} ${pct(d)}%`),
        "no coverage floor declared in vitest.config.ts (measured coverage reported as advisory)",
      ],
      dimensionsEvaluated: [...COVERAGE_DIMENSIONS],
      dimensionsSkipped: [],
    };
  }
  const below = COVERAGE_DIMENSIONS.filter((d) => pct(d) < floor);
  return {
    gateName: "coverage",
    gateVersion: "1.0.0",
    decision: below.length === 0 ? "pass" : "fail",
    reasons: below.map((d) => `${d} ${pct(d)}% < floor ${floor}%`),
    dimensionsEvaluated: [...COVERAGE_DIMENSIONS],
    dimensionsSkipped: [],
    ...(below.length === 0 ? {} : { failureMode: "coverage-below-floor" }),
  };
}

/**
 * Parse a declared coverage floor out of vitest config TEXT.
 *
 * The `lines:` token must appear INSIDE a `thresholds: {` block — a `lines:`
 * anywhere else (a comment, a reporter option) must NOT fabricate a floor and
 * flip the gate from advisory to pass/fail. (The previous regex made the
 * thresholds prefix OPTIONAL, so any `lines: N` in the file matched.)
 */
export function parseCoverageFloor(cfgText: string): number | null {
  const m = /\bthresholds\s*:\s*\{[\s\S]{0,400}?\blines\s*:\s*(\d+)/.exec(cfgText);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/** Read the lines threshold from vitest.config.ts. Returns null when undeclared. */
function coverageFloor(): number | null {
  try {
    return parseCoverageFloor(readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8"));
  } catch {
    return null;
  }
}

function firstLines(s: string, n: number): string {
  return s
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, n)
    .join(" ")
    .slice(0, 500);
}

function gitSha(): string {
  const r = run("git", ["rev-parse", "HEAD"]);
  return r.ok ? r.out.trim() : "0".repeat(40);
}

function harnessPolicyHash(): string {
  try {
    const h = readFileSync(join(process.cwd(), ".harness-hash"), "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(h)) return `sha256:${h}`;
  } catch {
    /* fall through */
  }
  // Fall back to a hash of the coverage policy doc if the manifest is absent.
  try {
    return `sha256:${sha256Hex(readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8"))}`;
  } catch {
    return `sha256:${sha256Hex("no-policy")}`;
  }
}

// ── Self-check (locally-runnable correctness proof) ──

function selfCheck(): void {
  const ctx = synthCtx();
  const outcomes: GateOutcome[] = [
    {
      gateName: "coverage",
      gateVersion: "1.0.0",
      decision: "advisory",
      advisorySeverity: "info",
      reasons: [
        "lines 84.21%",
        "branches 76.96%",
        "no coverage floor declared in vitest.config.ts",
      ],
      dimensionsEvaluated: [...COVERAGE_DIMENSIONS],
      dimensionsSkipped: [],
    },
    {
      gateName: "coverage",
      gateVersion: "1.0.0",
      decision: "fail",
      reasons: ["branches 70% < floor 80%"],
      dimensionsEvaluated: [...COVERAGE_DIMENSIONS],
      dimensionsSkipped: [],
      failureMode: "coverage-below-floor",
    },
  ];
  const rows = buildRows(outcomes, ctx); // throws if any artifact is kernel-invalid
  // Canonical bytes must be re-canonicalisation-stable (dashboard idempotence).
  for (const row of rows) {
    if (stableStringify(JSON.parse(row.canonicalBundle)) !== row.canonicalBundle) {
      throw new Error("canonical bundle is not stable under re-canonicalisation");
    }
  }
  if (rows.length !== 2) throw new Error("expected 2 rows");

  console.log(`✓ self-check: ${rows.length} kernel-valid, canonical-stable rows built`);
}

function synthCtx(): EmitContext {
  let n = 0;
  return {
    nowIso: "2026-06-08T00:00:00.000Z",
    nowMs: 1780617600000,
    commitSha: "a".repeat(40),
    sourceSha: "a".repeat(40),
    policyHash: `sha256:${"b".repeat(64)}`,
    runnerVersion: "1.1.0",
    // Deterministic, non-random 16-byte source so self-check output is stable.
    rand16: () => {
      n += 1;
      return Uint8Array.from(Array.from({ length: 16 }, (_v, i) => (n * 31 + i) & 0xff));
    },
  };
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function ciCtx(): EmitContext {
  const sha = gitSha();
  return {
    nowIso: new Date().toISOString(),
    nowMs: Date.now(),
    commitSha: sha,
    sourceSha: sha,
    policyHash: harnessPolicyHash(),
    runnerVersion: packageVersion(),
    rand16: () => Uint8Array.from(randomBytes(16)),
  };
}

function parseArgs(argv: readonly string[]): { out: string; selfCheck: boolean; ref: string } {
  let out = "build/evidence";
  let ref = process.env["GITHUB_REF"] ?? "refs/tags/v0.0.0";
  let sc = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = argv[i + 1] ?? out;
      i++;
    } else if (argv[i] === "--ref") {
      ref = argv[i + 1] ?? ref;
      i++;
    } else if (argv[i] === "--self-check") {
      sc = true;
    }
  }
  return { out, selfCheck: sc, ref };
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.selfCheck) {
    selfCheck();
    return 0;
  }
  const ctx = ciCtx();
  mkdirSync(args.out, { recursive: true });
  const outcomes: GateOutcome[] = [coverageOutcome(args.out)];
  const rows = buildRows(outcomes, ctx);
  writeEmit(rows, args.ref, args.out);

  console.log(
    `✓ emit-evidence: ${rows.length} kernel-valid gate-result/v1 row(s) written to ${args.out}\n` +
      `  decisions: ${outcomes.map((o) => `${o.gateName}=${o.decision}`).join(", ")}\n` +
      `  next (CI): cosign sign-blob each bundle-<i>.json -> assemble-manifest.ts -> report-manifest.json`,
  );
  return 0;
}

// Only run when invoked directly (not when imported by a sibling assembler/test).
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
