#!/usr/bin/env -S node --experimental-strip-types
/**
 * ci/emit-evidence/flap-report.ts — verdict-flap detection for the nightly
 * skill-eval roster: compare tonight's per-skill gate decisions against the
 * previously published report-manifest.json and surface every flip.
 *
 * ── Why ──
 *
 * Nightly runs of the SAME skills at the SAME pinned roster commit have been
 * observed to flap (run 29545349026 vs 29549429404: databricks-cluster-forensics
 * went 0/11 advisory -> 11/11 pass; coreweave-gpu-cost-leak-hunter went
 * advisory -> fail 7/10). A permanent signature must not ride a noisy verdict,
 * so flap visibility is a first-class integrity feature: anyone consuming the
 * evidence can see whether tonight's decision is stable night-over-night.
 *
 * ── What it is NOT ──
 *
 * NOT signed evidence. The signed gate-result/v1 EvidenceBundles stay a pure
 * function of tonight's run (ci/emit-evidence/emit-evidence.ts is untouched).
 * This is a SIDECAR report published next to the manifest, never inside it.
 *
 * ── Honest edge handling ──
 *
 *   - skill present in only one manifest -> recorded as "new" / "removed",
 *     NEVER counted as a flip;
 *   - previous manifest missing or unparseable -> the report says
 *     `previous: null, comparison: "first-run-or-unavailable"` and the script
 *     exits 0 (a missing baseline must never fail the nightly);
 *   - a broken CURRENT manifest is a pipeline bug -> fail closed (exit 1).
 *
 * Inputs:
 *   --previous <path>  previously published report-manifest.json
 *   --current  <path>  dir containing tonight's manifest-skeleton.json, or a
 *                      manifest file (skeleton or assembled — both carry
 *                      rows[].gateResults)
 * Outputs:
 *   --out (default build/evidence/flap-report.json) + a markdown summary on
 *   stdout (CI appends it to $GITHUB_STEP_SUMMARY).
 *
 * Usage:
 *   node --experimental-strip-types ci/emit-evidence/flap-report.ts \
 *     [--previous build/previous-manifest.json] [--current build/evidence] \
 *     [--out build/evidence/flap-report.json] [--self-check]
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One skill's verdict extracted from a manifest's gate-result rows. */
export interface Verdict {
  readonly decision: string;
  readonly reason: string | null;
}

export interface SkillFlapRow {
  readonly key: string;
  readonly previous_decision: string | null;
  readonly current_decision: string | null;
  readonly previous_reason: string | null;
  readonly current_reason: string | null;
  readonly flipped: boolean;
  /**
   * "compared"    — present in both manifests (flip detection applies)
   * "new"         — present only in the current manifest (never a flip)
   * "removed"     — present only in the previous manifest (never a flip)
   * "no-baseline" — no previous manifest at all (first run / unavailable)
   */
  readonly status: "compared" | "new" | "removed" | "no-baseline";
}

export interface FlapReport {
  readonly comparison: "ok" | "first-run-or-unavailable";
  readonly previous: string | null;
  readonly previous_unavailable_reason?: string;
  readonly skills: readonly SkillFlapRow[];
  readonly totals: {
    readonly compared: number;
    readonly flipped: number;
    readonly stable: number;
    readonly new: number;
    readonly removed: number;
    readonly no_baseline: number;
  };
}

// ── Verdict extraction (shape-tolerant, but never silently empty) ──

/**
 * Pull `gate_name -> {decision, reason}` out of any manifest-like object whose
 * `rows[]` carry `gateResults[]` (true for both the emit skeleton and the
 * assembled report-manifest.json). First occurrence of a key wins. Throws if
 * nothing usable is found — an empty verdict map means the input is not a
 * manifest, and comparing against it would be fake stability.
 */
export function extractVerdicts(manifest: unknown, label: string): Map<string, Verdict> {
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error(`${label}: not a JSON object`);
  }
  const rows = (manifest as Record<string, unknown>)["rows"];
  if (!Array.isArray(rows)) {
    throw new Error(`${label}: has no rows[] array — not a manifest/skeleton`);
  }
  const verdicts = new Map<string, Verdict>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const gateResults = (row as Record<string, unknown>)["gateResults"];
    if (!Array.isArray(gateResults)) continue;
    for (const gr of gateResults) {
      if (typeof gr !== "object" || gr === null) continue;
      const g = gr as Record<string, unknown>;
      const key = g["gate_name"];
      const decision = g["gate_decision"];
      if (typeof key !== "string" || typeof decision !== "string") continue;
      if (verdicts.has(key)) continue;
      const reasons = g["gate_reasons"];
      const first = Array.isArray(reasons) && typeof reasons[0] === "string" ? reasons[0] : null;
      verdicts.set(key, { decision, reason: first });
    }
  }
  if (verdicts.size === 0) {
    throw new Error(`${label}: no gate-result rows with gate_name + gate_decision found`);
  }
  return verdicts;
}

/** Load tonight's verdicts. Fail-closed: a broken current side is a pipeline bug. */
export function loadCurrentVerdicts(currentPath: string): Map<string, Verdict> {
  const path =
    existsSync(currentPath) && statSync(currentPath).isDirectory()
      ? join(currentPath, "manifest-skeleton.json")
      : currentPath;
  if (!existsSync(path)) {
    throw new Error(`current manifest ${path} not found — run emit-evidence.ts first`);
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return extractVerdicts(parsed, `current (${path})`);
}

/**
 * Load the previous night's verdicts. NEVER throws: a missing, unfetchable, or
 * malformed previous manifest degrades to `null` (first-run-or-unavailable) —
 * the nightly must not fail because last night's baseline is gone.
 */
export function loadPreviousVerdicts(previousPath: string): {
  readonly verdicts: Map<string, Verdict> | null;
  readonly reason: string | null;
} {
  try {
    if (!existsSync(previousPath)) {
      return { verdicts: null, reason: `previous manifest ${previousPath} not present` };
    }
    const parsed: unknown = JSON.parse(readFileSync(previousPath, "utf8"));
    return { verdicts: extractVerdicts(parsed, `previous (${previousPath})`), reason: null };
  } catch (err: unknown) {
    return { verdicts: null, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ── Comparison (pure) ──

export function buildFlapReport(
  previous: Map<string, Verdict> | null,
  current: Map<string, Verdict>,
  previousPath: string,
  previousUnavailableReason: string | null,
): FlapReport {
  const skills: SkillFlapRow[] = [];
  if (previous === null) {
    for (const key of [...current.keys()].sort()) {
      const cur = current.get(key)!;
      skills.push({
        key,
        previous_decision: null,
        current_decision: cur.decision,
        previous_reason: null,
        current_reason: cur.reason,
        flipped: false,
        status: "no-baseline",
      });
    }
    return {
      comparison: "first-run-or-unavailable",
      previous: null,
      ...(previousUnavailableReason !== null
        ? { previous_unavailable_reason: previousUnavailableReason }
        : {}),
      skills,
      totals: {
        compared: 0,
        flipped: 0,
        stable: 0,
        new: 0,
        removed: 0,
        no_baseline: skills.length,
      },
    };
  }

  const allKeys = [...new Set([...previous.keys(), ...current.keys()])].sort();
  for (const key of allKeys) {
    const prev = previous.get(key) ?? null;
    const cur = current.get(key) ?? null;
    const status: SkillFlapRow["status"] =
      prev !== null && cur !== null ? "compared" : prev === null ? "new" : "removed";
    skills.push({
      key,
      previous_decision: prev?.decision ?? null,
      current_decision: cur?.decision ?? null,
      previous_reason: prev?.reason ?? null,
      current_reason: cur?.reason ?? null,
      // Only a skill present in BOTH manifests can flip — new/removed never do.
      flipped: status === "compared" && prev!.decision !== cur!.decision,
      status,
    });
  }
  const compared = skills.filter((s) => s.status === "compared");
  return {
    comparison: "ok",
    previous: previousPath,
    skills,
    totals: {
      compared: compared.length,
      flipped: compared.filter((s) => s.flipped).length,
      stable: compared.filter((s) => !s.flipped).length,
      new: skills.filter((s) => s.status === "new").length,
      removed: skills.filter((s) => s.status === "removed").length,
      no_baseline: 0,
    },
  };
}

// ── Markdown rendering (for $GITHUB_STEP_SUMMARY) ──

export function renderMarkdown(report: FlapReport): string {
  const lines: string[] = ["## Verdict-flap report (nightly integrity sidecar)", ""];
  if (report.comparison === "first-run-or-unavailable") {
    lines.push(
      "No previous manifest was available (first run or unfetchable) — no flap comparison " +
        "performed. Tonight's verdicts, recorded without a baseline:",
      "",
      "| Skill | Decision |",
      "| --- | --- |",
    );
    for (const s of report.skills) lines.push(`| ${s.key} | ${s.current_decision ?? "-"} |`);
    lines.push("");
    return lines.join("\n");
  }
  lines.push(
    "Tonight's per-skill decisions compared against the previously published manifest.",
    "",
    "| Skill | Previous | Current | Status |",
    "| --- | --- | --- | --- |",
  );
  for (const s of report.skills) {
    const status = s.status === "compared" ? (s.flipped ? "FLIPPED" : "stable") : s.status;
    lines.push(
      `| ${s.key} | ${s.previous_decision ?? "-"} | ${s.current_decision ?? "-"} | ${status} |`,
    );
  }
  const t = report.totals;
  lines.push(
    "",
    `**Totals:** ${t.compared} compared, ${t.flipped} flipped, ${t.stable} stable, ` +
      `${t.new} new, ${t.removed} removed`,
  );
  const flips = report.skills.filter((s) => s.flipped);
  if (flips.length === 0) {
    lines.push("", "No verdict flips detected — tonight's decisions match the previous run.");
  } else {
    lines.push("", "### Flipped verdicts (a permanent signature must not ride a noisy verdict)");
    for (const s of flips) {
      lines.push(
        `- **${s.key}**: ${s.previous_decision} -> ${s.current_decision}`,
        `  - previous reason: ${s.previous_reason ?? "(none recorded)"}`,
        `  - current reason: ${s.current_reason ?? "(none recorded)"}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ── Self-check (locally-runnable correctness proof, zero fixtures on disk) ──

function assertEq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`self-check FAILED: ${what}: expected ${e}, got ${a}`);
}

function synthManifest(entries: readonly [string, string, string][]): unknown {
  return {
    repo: "jrig",
    signing: { issuer: "i", subject: "s", workflowRef: "w" },
    rows: entries.map(([name, decision, reason]) => ({
      bundleFile: `bundle-${name}.json`,
      sourceSha: "a".repeat(40),
      gateResults: [{ gate_name: name, gate_decision: decision, gate_reasons: [reason] }],
    })),
  };
}

function selfCheck(): void {
  const previous = extractVerdicts(
    synthManifest([
      ["skill-stable", "pass", "17/17 criteria passed"],
      ["skill-flappy", "advisory", "0/11 criteria passed"],
      ["skill-retired", "pass", "12/12 criteria passed"],
    ]),
    "self-check previous",
  );
  const current = extractVerdicts(
    synthManifest([
      ["skill-stable", "pass", "17/17 criteria passed"],
      ["skill-flappy", "pass", "11/11 criteria passed"],
      ["skill-fresh", "fail", "7/10 criteria passed"],
    ]),
    "self-check current",
  );

  // 1. A flip IS detected (advisory -> pass), with first reasons carried.
  const report = buildFlapReport(previous, current, "prev.json", null);
  const byKey = new Map(report.skills.map((s) => [s.key, s]));
  assertEq(byKey.get("skill-flappy")?.flipped, true, "flip detected");
  assertEq(byKey.get("skill-flappy")?.previous_decision, "advisory", "flip previous decision");
  assertEq(byKey.get("skill-flappy")?.current_decision, "pass", "flip current decision");
  assertEq(byKey.get("skill-flappy")?.previous_reason, "0/11 criteria passed", "flip prev reason");
  assertEq(byKey.get("skill-flappy")?.current_reason, "11/11 criteria passed", "flip cur reason");

  // 2. A stable verdict is NOT flagged.
  assertEq(byKey.get("skill-stable")?.flipped, false, "stable verdict not flagged");
  assertEq(byKey.get("skill-stable")?.status, "compared", "stable verdict compared");

  // 3. A skill present in only one manifest is new/removed, never a flip.
  assertEq(byKey.get("skill-fresh")?.status, "new", "current-only skill is new");
  assertEq(byKey.get("skill-fresh")?.flipped, false, "new skill is not a flip");
  assertEq(byKey.get("skill-retired")?.status, "removed", "previous-only skill is removed");
  assertEq(byKey.get("skill-retired")?.flipped, false, "removed skill is not a flip");
  assertEq(
    report.totals,
    { compared: 2, flipped: 1, stable: 1, new: 1, removed: 1, no_baseline: 0 },
    "totals",
  );

  // 4. Missing/unreadable previous is graceful: null verdicts, honest report.
  const missing = loadPreviousVerdicts(join("build", "does-not-exist.json"));
  assertEq(missing.verdicts, null, "missing previous loads as null");
  const firstRun = buildFlapReport(null, current, "prev.json", missing.reason);
  assertEq(firstRun.comparison, "first-run-or-unavailable", "first-run comparison marker");
  assertEq(firstRun.previous, null, "first-run previous is null");
  assertEq(firstRun.totals.flipped, 0, "first-run reports zero flips");
  assertEq(firstRun.totals.no_baseline, 3, "first-run records all current skills");

  // 5. Markdown renders for both shapes without throwing, and names the flip.
  const md = renderMarkdown(report);
  if (!md.includes("FLIPPED") || !md.includes("skill-flappy")) {
    throw new Error("self-check FAILED: markdown does not surface the flipped skill");
  }
  renderMarkdown(firstRun);

  console.log(
    "self-check OK: flip detected, stable not flagged, new/removed never flips, " +
      "missing previous degrades gracefully",
  );
}

// ── CLI ──

function parseArgs(argv: readonly string[]): {
  previous: string;
  current: string;
  out: string;
  selfCheck: boolean;
} {
  let previous = join("build", "previous-manifest.json");
  let current = join("build", "evidence");
  let out = join("build", "evidence", "flap-report.json");
  let sc = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--previous") {
      previous = argv[i + 1] ?? previous;
      i++;
    } else if (argv[i] === "--current") {
      current = argv[i + 1] ?? current;
      i++;
    } else if (argv[i] === "--out") {
      out = argv[i + 1] ?? out;
      i++;
    } else if (argv[i] === "--self-check") {
      sc = true;
    }
  }
  return { previous, current, out, selfCheck: sc };
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.selfCheck) {
    selfCheck();
    return 0;
  }
  const current = loadCurrentVerdicts(args.current); // fail-closed
  const { verdicts: previous, reason } = loadPreviousVerdicts(args.previous); // never throws
  const report = buildFlapReport(previous, current, args.previous, reason);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2), "utf8");
  console.log(renderMarkdown(report));
  return 0;
}

// Only run when invoked directly (not when imported by a sibling script).
const invokedDirectly = process.argv[1]?.endsWith("flap-report.ts") === true;
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error(
      "flap-report FAILED (fail-closed on the current side only):",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}
