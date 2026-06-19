import { describe, it, expect } from "vitest";
import { computeProviderScoreCard, draftDecisionRecordFragment, locToScore } from "./score-card.js";
import type { ECSuiteResult, ECResult } from "../eval-cases/index.js";

function ec(
  name: ECResult["ec"],
  perModel: Array<{ model: string; pass: boolean; notes?: string }>,
): ECResult {
  return {
    ec: name,
    provider: "test-provider",
    perModel: perModel.map((m) => ({
      model: m.model,
      pass: m.pass,
      notes: m.notes ?? "",
    })),
    harnessOk: true,
    durationMs: 100,
  };
}

function suite(results: ECResult[]): ECSuiteResult {
  return { provider: "test-provider", results, totalDurationMs: 1000 };
}

describe("locToScore", () => {
  it("scores < 300 LOC as 3", () => {
    expect(locToScore(0)).toBe(3);
    expect(locToScore(150)).toBe(3);
    expect(locToScore(299)).toBe(3);
  });
  it("scores 300-600 as 2", () => {
    expect(locToScore(300)).toBe(2);
    expect(locToScore(600)).toBe(2);
  });
  it("scores 601-1000 as 1", () => {
    expect(locToScore(700)).toBe(1);
    expect(locToScore(1000)).toBe(1);
  });
  it("scores > 1000 as 0", () => {
    expect(locToScore(1001)).toBe(0);
    expect(locToScore(5000)).toBe(0);
  });
});

describe("computeProviderScoreCard — request-side coverage (R5.3)", () => {
  const allPass = [
    { model: "anthropic", pass: true },
    { model: "openai", pass: true },
    { model: "google", pass: true },
  ];
  const twoPass = [
    { model: "anthropic", pass: true },
    { model: "openai", pass: true },
    { model: "google", pass: false },
  ];
  const onePass = [
    { model: "anthropic", pass: true },
    { model: "openai", pass: false },
    { model: "google", pass: false },
  ];
  const allFail = [
    { model: "anthropic", pass: false },
    { model: "openai", pass: false },
    { model: "google", pass: false },
  ];

  it("scores 3 per EC when all 3 providers pass", () => {
    const s = computeProviderScoreCard({
      suite: suite([
        ec("EC-1", allPass),
        ec("EC-2", allPass),
        ec("EC-3", allPass),
        ec("EC-4", allPass),
        ec("EC-5", allPass),
      ]),
      typeSafetyScore: 3,
      adapterLoc: 100,
    });
    expect(s.rubric.requestSideCoverage).toBe(15);
  });

  it("scores 2 when 2 of 3 pass per EC", () => {
    const s = computeProviderScoreCard({
      suite: suite([
        ec("EC-1", twoPass),
        ec("EC-2", twoPass),
        ec("EC-3", twoPass),
        ec("EC-4", twoPass),
        ec("EC-5", twoPass),
      ]),
      typeSafetyScore: 3,
      adapterLoc: 100,
    });
    expect(s.rubric.requestSideCoverage).toBe(10);
  });

  it("scores mixed across ECs", () => {
    const s = computeProviderScoreCard({
      suite: suite([
        ec("EC-1", allPass),
        ec("EC-2", twoPass),
        ec("EC-3", onePass),
        ec("EC-4", allFail),
        ec("EC-5", allPass),
      ]),
      typeSafetyScore: 3,
      adapterLoc: 100,
    });
    // 3 + 2 + 1 + 0 + 3 = 9
    expect(s.rubric.requestSideCoverage).toBe(9);
  });
});

describe("computeProviderScoreCard — runtime error categories (R5.4)", () => {
  it("scores 0 when EC-4 missing", () => {
    const s = computeProviderScoreCard({
      suite: suite([ec("EC-1", [{ model: "anthropic", pass: true }])]),
      typeSafetyScore: 0,
      adapterLoc: 100,
    });
    expect(s.rubric.runtimeErrorCategories).toBe(0);
  });

  it("scores 15 when all 5 categories are 'expected' across all models", () => {
    const notesAllExpected =
      "vendor=anthropic: authentication:expected, rate_limit:expected, model_not_found:expected, content_policy_refusal:expected, network_timeout:expected";
    const s = computeProviderScoreCard({
      suite: suite([
        ec("EC-4", [
          {
            model: "anthropic",
            pass: true,
            notes: notesAllExpected.replace("anthropic", "anthropic"),
          },
          { model: "openai", pass: true, notes: notesAllExpected.replace("anthropic", "openai") },
          { model: "google", pass: true, notes: notesAllExpected.replace("anthropic", "google") },
        ]),
      ]),
      typeSafetyScore: 0,
      adapterLoc: 100,
    });
    expect(s.rubric.runtimeErrorCategories).toBe(15);
  });

  it("scores 'wrong-category' as 1 per category", () => {
    const notes =
      "vendor=anthropic: authentication:wrong-category, rate_limit:expected, model_not_found:missing, content_policy_refusal:skipped, network_timeout:skipped";
    const s = computeProviderScoreCard({
      suite: suite([ec("EC-4", [{ model: "anthropic", pass: false, notes }])]),
      typeSafetyScore: 0,
      adapterLoc: 100,
    });
    // 1 (auth wrong) + 3 (rate_limit expected) + 0 (model_not_found missing) + 0 + 0 = 4
    expect(s.rubric.runtimeErrorCategories).toBe(4);
  });
});

describe("computeProviderScoreCard — CISO gate disqualification flagging", () => {
  it("flags G-1 failure", () => {
    const s = computeProviderScoreCard({
      suite: suite([ec("EC-1", [{ model: "a", pass: true }])]),
      typeSafetyScore: 3,
      adapterLoc: 100,
      cisoG1Pass: false,
      cisoG2Pass: true,
    });
    expect(s.cisoGateFailures).toContain("G-1-credential-redaction");
    expect(s.cisoGateFailures).not.toContain("G-2-env-var-spillover");
  });

  it("flags G-2 failure", () => {
    const s = computeProviderScoreCard({
      suite: suite([ec("EC-1", [{ model: "a", pass: true }])]),
      typeSafetyScore: 3,
      adapterLoc: 100,
      cisoG1Pass: true,
      cisoG2Pass: false,
    });
    expect(s.cisoGateFailures).toContain("G-2-env-var-spillover");
  });

  it("no flags when both pass", () => {
    const s = computeProviderScoreCard({
      suite: suite([ec("EC-1", [{ model: "a", pass: true }])]),
      typeSafetyScore: 3,
      adapterLoc: 100,
      cisoG1Pass: true,
      cisoG2Pass: true,
    });
    expect(s.cisoGateFailures).toEqual([]);
  });

  it("no flags when gate results are undefined (caller hasn't run them yet)", () => {
    const s = computeProviderScoreCard({
      suite: suite([ec("EC-1", [{ model: "a", pass: true }])]),
      typeSafetyScore: 3,
      adapterLoc: 100,
    });
    expect(s.cisoGateFailures).toEqual([]);
  });
});

describe("computeProviderScoreCard — total + perEcSummary", () => {
  it("total sums all four dimensions correctly", () => {
    const s = computeProviderScoreCard({
      suite: suite([
        ec("EC-1", [
          { model: "a", pass: true },
          { model: "b", pass: true },
          { model: "c", pass: true },
        ]),
      ]),
      typeSafetyScore: 2,
      adapterLoc: 500, // R5.2 score = 2
    });
    // R5.1=2 + R5.2=2 + R5.3=3 (EC-1 all pass) + R5.4=0 (no EC-4) = 7
    expect(s.total).toBe(7);
  });

  it("perEcSummary reflects pass counts per EC", () => {
    const s = computeProviderScoreCard({
      suite: suite([
        ec("EC-1", [
          { model: "a", pass: true },
          { model: "b", pass: false },
          { model: "c", pass: true },
        ]),
        ec("EC-2", [
          { model: "a", pass: true },
          { model: "b", pass: true },
          { model: "c", pass: true },
        ]),
      ]),
      typeSafetyScore: 0,
      adapterLoc: 100,
    });
    expect(s.perEcSummary).toEqual([
      { ec: "EC-1", passCount: 2, total: 3 },
      { ec: "EC-2", passCount: 3, total: 3 },
    ]);
  });
});

describe("draftDecisionRecordFragment", () => {
  it("produces markdown with all required sections per PB-7 § 10", () => {
    const cards = [
      computeProviderScoreCard({
        suite: suite([
          ec("EC-1", [
            { model: "a", pass: true },
            { model: "b", pass: true },
            { model: "c", pass: true },
          ]),
        ]),
        typeSafetyScore: 3,
        adapterLoc: 250,
        cisoG1Pass: true,
        cisoG2Pass: true,
      }),
      computeProviderScoreCard({
        suite: suite([
          ec("EC-1", [
            { model: "a", pass: false },
            { model: "b", pass: true },
            { model: "c", pass: false },
          ]),
        ]),
        typeSafetyScore: 2,
        adapterLoc: 700,
        cisoG1Pass: true,
        cisoG2Pass: false, // disqualified
      }),
    ];
    const md = draftDecisionRecordFragment(cards);
    expect(md).toContain("CISO gate status");
    expect(md).toContain("Rubric scores (PB-7 § 5)");
    expect(md).toContain("Per-EC pass counts");
    expect(md).toContain("❌ FAIL");
    expect(md).toContain("✅ PASS");
    expect(md).toContain("DISQUALIFICATION ANTI-PATTERN");
    // First card total: R5.1=3 + R5.2=3 (250<300 LOC) + R5.3=3 (EC-1 3/3) + R5.4=0 (no EC-4) = 9/36
    expect(md).toContain("**9/36**");
  });

  it("handles empty cards gracefully", () => {
    const md = draftDecisionRecordFragment([]);
    expect(md).toContain("no score cards available");
  });
});
