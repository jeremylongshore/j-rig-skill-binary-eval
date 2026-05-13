/**
 * Score-card scoring — computes the PB-7 § 5 rubric dimensions from
 * ECSuiteResult.
 *
 * Source: PB-7 measurement protocol § 5 (the 4 rubric dimensions) +
 * § 9 (tiebreaker dimension) + § 10 (Decision Record acceptance).
 *
 * This module is PURE — no IO, no time-dependent randomness, no globals.
 * Same ECSuiteResult input always produces the same ScoreCard output.
 * That property is the central protection against the anti-pattern in
 * PB-7 § 12 ("retro-fitting the rubric to the result"). If we ever feel
 * the urge to "adjust" the rubric mid-measurement, we adjust this module
 * in a commit that runs BEFORE the next measurement — never mutate
 * scoring between providers.
 *
 * Two of the four rubric dimensions (R5.1 type-safety, R5.2 LOC) cannot
 * be derived from ECSuiteResult alone — they require static analysis of
 * the adapter's source. Those dimensions are accepted as INPUT to the
 * scorer; the protocol's discipline is to measure them ONCE per prototype
 * (via `tsc --strict` + `cloc`) and pass the measured numbers through.
 */

import type { ECResult, ECSuiteResult } from "../eval-cases/index.js";

// --- Static-analysis inputs (caller measures these once per prototype) ---

export interface StaticAnalysisInputs {
  /**
   * R5.1 (type safety). Score values per PB-7 § 5.1:
   *   3 = full TS types; tsc --strict clean; tool-call schemas type-narrow
   *   2 = types cover public API but internals use any/unknown; --strict clean
   *   1 = partial types or --strict warnings
   *   0 = untyped / any pervasive
   */
  typeSafetyScore: 0 | 1 | 2 | 3;
  /**
   * R5.2 (LOC). Measured via `cloc packages/cli/src/providers/<adapter>.ts`
   * excluding tests + fixtures. PB-7 § 5.2:
   *   3 = < 300 LOC
   *   2 = 300-600 LOC
   *   1 = 600-1000 LOC
   *   0 = > 1000 LOC
   */
  adapterLoc: number;
}

// --- Rubric dimension scores ---

export interface RubricScores {
  /** R5.1 — 0..3 */
  typeSafety: 0 | 1 | 2 | 3;
  /** R5.2 — 0..3 */
  loc: 0 | 1 | 2 | 3;
  /**
   * R5.3 — request-side feature coverage. Sum across EC-1..EC-5; max 15.
   * 3 = passes ALL 3 providers identically
   * 2 = passes 2 of 3 identically
   * 1 = passes 1 of 3 OR all 3 with caller-side divergence
   * 0 = doesn't handle the case
   *
   * The scorer collapses ECPerModelOutcome.pass per EC into a single
   * 0..3 score per the rule above.
   */
  requestSideCoverage: number;
  /**
   * R5.4 — runtime error categories. EC-4 reports per-trigger
   * "expected" / "missing" / "wrong-category" / "skipped". Mapping per
   * PB-7 § 5.4:
   *   3 per category = expected + caller can recover (treat "expected" as 3)
   *   2 = unified error type but category boundaries unclear (not currently
   *       detectable from EC-4 output alone — protocol assumes
   *       "expected" is the only way to score 3; finer gradation requires
   *       static analysis the scorer can't do)
   *   1 = surfaces provider-specific error class (wrong-category)
   *   0 = generic Error thrown (missing)
   *
   * Max 15 (5 categories × 3).
   */
  runtimeErrorCategories: number;
}

export interface ProviderScoreCard {
  provider: string;
  rubric: RubricScores;
  /** Sum of all 4 dimensions; max = 3 + 3 + 15 + 15 = 36. */
  total: number;
  /** Per-EC pass count summary; informative. */
  perEcSummary: Array<{ ec: ECResult["ec"]; passCount: number; total: number }>;
  /** Categories where this candidate was disqualified, if any (CISO gates). */
  cisoGateFailures: string[];
}

// --- The scorer ---

export interface ProviderScoreCardInputs extends StaticAnalysisInputs {
  suite: ECSuiteResult;
  /** Optional CISO gate outcomes; if any FAIL, the scorer flags disqualification. */
  cisoG1Pass?: boolean;
  cisoG2Pass?: boolean;
}

export function computeProviderScoreCard(input: ProviderScoreCardInputs): ProviderScoreCard {
  const requestSideCoverage = sumRequestSideCoverage(input.suite.results);
  const runtimeErrorCategories = sumRuntimeErrorCategories(input.suite.results);
  const locScore = locToScore(input.adapterLoc);

  const cisoGateFailures: string[] = [];
  if (input.cisoG1Pass === false) cisoGateFailures.push("G-1-credential-redaction");
  if (input.cisoG2Pass === false) cisoGateFailures.push("G-2-env-var-spillover");

  const rubric: RubricScores = {
    typeSafety: input.typeSafetyScore,
    loc: locScore,
    requestSideCoverage,
    runtimeErrorCategories,
  };

  return {
    provider: input.suite.provider,
    rubric,
    total:
      rubric.typeSafety + rubric.loc + rubric.requestSideCoverage + rubric.runtimeErrorCategories,
    perEcSummary: input.suite.results.map((r) => ({
      ec: r.ec,
      passCount: r.perModel.filter((m) => m.pass).length,
      total: r.perModel.length,
    })),
    cisoGateFailures,
  };
}

// --- R5.2 LOC mapping ---

export function locToScore(loc: number): 0 | 1 | 2 | 3 {
  if (loc < 300) return 3;
  if (loc <= 600) return 2;
  if (loc <= 1000) return 1;
  return 0;
}

// --- R5.3 sum across EC-1..EC-5 ---

function sumRequestSideCoverage(results: ECResult[]): number {
  return results.reduce((acc, r) => acc + scoreEcCoverage(r), 0);
}

function scoreEcCoverage(r: ECResult): number {
  const passes = r.perModel.filter((m) => m.pass).length;
  const total = r.perModel.length;
  if (total === 0) return 0;
  // Proportional scoring: 3=all, 2=~66%, 1=~33%, 0=none. Robust for any
  // model-set size (correctly handles the 3-provider canonical case
  // 3/3=3, 2/3=2, 1/3=1 AND extended sets like 4 providers where
  // 3 passes scores ~2 instead of falling through every special case to 0).
  return Math.min(3, Math.max(0, Math.round((passes / total) * 3))) as 0 | 1 | 2 | 3;
}

// --- R5.4 runtime-error category sum ---

/**
 * EC-4 records per-trigger status in the perModel notes. To compute the
 * R5.4 score we parse those notes back. This is a known coupling — keep
 * the EC-4 notes-format and this parser changing together.
 *
 * The format produced by ec-4-error-categories.ts:
 *   "vendor=<x>: authentication:<status>, rate_limit:<status>, ..."
 * Statuses: expected | missing | wrong-category | skipped.
 *
 * Scoring (per category, summed to a 0..15 per-model score):
 *   expected       → 3 points (unified error category — full credit)
 *   wrong-category → 1 point  (error surfaced but category boundary wrong)
 *   missing        → 0 points (generic Error thrown, no unified category)
 *   skipped        → 0 points (trigger wasn't run for this measurement run)
 *
 * The PR description's "no penalty for skipped" wording is misleading
 * relative to this 0-point treatment. We DO score skipped as 0 — but the
 * R5.4 maximum is fixed at 15 across all 5 categories, so a measurement
 * run that skips, say, network_timeout effectively caps the candidate at
 * 12/15 even if everything else is "expected". The PB-7 protocol's intent
 * here is "run all 5 categories per candidate before locking the decision"
 * — skipping is allowed during prototype iteration but locks in a lower
 * score. If a candidate's measurement run shows a skip, the council should
 * either re-run the trigger or document the skip in the Decision Record.
 *
 * Sum across all 5 trigger categories; max 15 per model. We average across
 * the 3 models to land on a single 0..15 per-prototype value.
 */
function sumRuntimeErrorCategories(results: ECResult[]): number {
  const ec4 = results.find((r) => r.ec === "EC-4");
  if (!ec4 || ec4.perModel.length === 0) return 0;

  const perModelScores = ec4.perModel.map((m) => scoreEc4ModelNotes(m.notes));
  const avg = perModelScores.reduce((a, b) => a + b, 0) / perModelScores.length;
  return Math.round(avg);
}

function scoreEc4ModelNotes(notes: string): number {
  // notes format: "vendor=X: cat:status, cat:status, ..."
  const statusByCategory = new Map<string, string>();
  const tail = notes.split(":").slice(1).join(":"); // strip "vendor=X" prefix
  for (const pair of tail.split(",").map((s) => s.trim())) {
    const [cat, status] = pair.split(":").map((s) => s.trim());
    if (cat && status) statusByCategory.set(cat, status);
  }
  let score = 0;
  for (const cat of [
    "authentication",
    "rate_limit",
    "model_not_found",
    "content_policy_refusal",
    "network_timeout",
  ]) {
    const s = statusByCategory.get(cat);
    if (s === "expected") score += 3;
    else if (s === "wrong-category") score += 1;
    // missing + skipped + unknown → 0
  }
  return score;
}

// --- Decision Record draft generator ---

/**
 * Emit a Decision Record draft fragment in markdown, mirroring PB-7 § 10
 * acceptance criteria. The output is a TEMPLATE the eventual locking
 * council fills in — it's NOT a complete Decision Record. The council
 * must add: rationale anchored to the data, dissent surface, council
 * memos.
 */
export function draftDecisionRecordFragment(cards: ProviderScoreCard[]): string {
  if (cards.length === 0) return "_(no score cards available)_";
  const lines: string[] = [];
  lines.push("## Provider-adapter measurement results");
  lines.push("");
  lines.push("Per PB-7 measurement protocol (`000-docs/018-AT-SPEC`) § 10.");
  lines.push("");
  lines.push("### CISO gate status");
  lines.push("");
  lines.push("| Candidate | G-1 credential redaction | G-2 env-var spillover |");
  lines.push("|---|---|---|");
  for (const c of cards) {
    const g1 = c.cisoGateFailures.includes("G-1-credential-redaction") ? "❌ FAIL" : "✅ PASS";
    const g2 = c.cisoGateFailures.includes("G-2-env-var-spillover") ? "❌ FAIL" : "✅ PASS";
    lines.push(`| \`${c.provider}\` | ${g1} | ${g2} |`);
  }
  lines.push("");
  lines.push("**DISQUALIFICATION ANTI-PATTERN (PB-7 § 12): any G-1 or G-2 failure DISQUALIFIES the candidate. Do NOT proceed to rubric scoring for a candidate that failed a CISO gate.**");
  lines.push("");
  lines.push("### Rubric scores (PB-7 § 5)");
  lines.push("");
  lines.push("| Candidate | R5.1 type | R5.2 loc | R5.3 cov | R5.4 err | Total |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of cards) {
    lines.push(
      `| \`${c.provider}\` | ${c.rubric.typeSafety}/3 | ${c.rubric.loc}/3 | ${c.rubric.requestSideCoverage}/15 | ${c.rubric.runtimeErrorCategories}/15 | **${c.total}/36** |`,
    );
  }
  lines.push("");
  lines.push("### Per-EC pass counts (informative)");
  lines.push("");
  lines.push("| Candidate | EC-1 | EC-2 | EC-3 | EC-4 | EC-5 |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of cards) {
    const cell = (ec: string) => {
      const s = c.perEcSummary.find((p) => p.ec === ec);
      return s ? `${s.passCount}/${s.total}` : "n/a";
    };
    lines.push(`| \`${c.provider}\` | ${cell("EC-1")} | ${cell("EC-2")} | ${cell("EC-3")} | ${cell("EC-4")} | ${cell("EC-5")} |`);
  }
  lines.push("");
  lines.push("### What this fragment does NOT include (council fills in)");
  lines.push("");
  lines.push("- The choice (which candidate locks)");
  lines.push("- The rationale anchored in the data above");
  lines.push("- Dissent surface (any seat that voted against)");
  lines.push("- Council seat memos (verbatim, per ISEDC pattern)");
  lines.push("- Tiebreaker invocation (§ 9) if the rubric totals are within ±1");
  lines.push("- GC license audit output (§ 8) + NOTICE diff");
  return lines.join("\n");
}
