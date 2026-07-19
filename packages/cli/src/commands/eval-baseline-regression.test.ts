import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegressionBaseline } from "./eval.js";
import {
  detectRegressions,
  compareBaseline,
  isObsoleteCandidate,
  computeScoreCard,
  decideRollout,
} from "@j-rig/core";
import type { JudgmentResult, Criterion } from "@j-rig/core";

// Layer 4 (regression) + Layer 5 (baseline) plumbing — #222.
// The governance functions are unit-tested in core; this proves the CLI-side
// contract eval.ts now wires: loading a prior-run baseline, and the exact
// detectRegressions -> computeScoreCard -> decideRollout chain that must BLOCK
// on a sacred regression (the thing the empty-array skip previously could not do).

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
function writeBaseline(rows: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "jrig-regbaseline-"));
  tmp.push(dir);
  const p = join(dir, "baseline.json");
  writeFileSync(p, typeof rows === "string" ? rows : JSON.stringify(rows));
  return p;
}
const j = (criterion_id: string, verdict: "yes" | "no" | "unsure"): JudgmentResult => ({
  criterion_id,
  verdict,
  confidence: 1,
  reasoning: "",
  method: "judge",
});

describe("loadRegressionBaseline (--regression-baseline loader, #222)", () => {
  it("parses a valid {criterion_id, verdict}[] file into minimal JudgmentResults", () => {
    const path = writeBaseline([
      { criterion_id: "c1", verdict: "yes" },
      { criterion_id: "c2", verdict: "no" },
    ]);
    const loaded = loadRegressionBaseline(path);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ criterion_id: "c1", verdict: "yes", method: "judge" });
  });

  it("fails LOUD on a non-array (never silently skips the regression layer)", () => {
    expect(() =>
      loadRegressionBaseline(writeBaseline({ criterion_id: "c1", verdict: "yes" })),
    ).toThrow(/must be a JSON array/);
  });

  it("fails LOUD on an invalid verdict", () => {
    expect(() =>
      loadRegressionBaseline(writeBaseline([{ criterion_id: "c1", verdict: "maybe" }])),
    ).toThrow(/verdict of yes\|no\|unsure/);
  });

  it("fails LOUD on a missing criterion_id", () => {
    expect(() => loadRegressionBaseline(writeBaseline([{ verdict: "yes" }]))).toThrow(
      /string criterion_id/,
    );
  });

  it("fails LOUD on an unreadable path", () => {
    expect(() => loadRegressionBaseline("/no/such/baseline.json")).toThrow(/could not read\/parse/);
  });
});

describe("regression wiring — a sacred regression BLOCKS (the chain eval.ts wires, #222)", () => {
  const criteria: Criterion[] = [
    {
      id: "c-sacred",
      description: "must never break",
      method: "judge",
      regression_critical: true,
    } as Criterion,
    { id: "c-plain", description: "nice to have", method: "judge" } as Criterion,
  ];

  it("loaded baseline + regressed sacred criterion -> detectRegressions -> computeScoreCard -> decideRollout = block", () => {
    const path = writeBaseline([
      { criterion_id: "c-sacred", verdict: "yes" }, // passed before
      { criterion_id: "c-plain", verdict: "yes" },
    ]);
    const previous = loadRegressionBaseline(path);
    const current = [j("c-sacred", "no"), j("c-plain", "yes")]; // sacred criterion now fails

    const regressions = detectRegressions(previous, current, criteria);
    expect(regressions.some((r) => r.is_sacred)).toBe(true);

    // The exact wiring: regressions flow into the score card, which decides block.
    const score = computeScoreCard(current, criteria, regressions);
    expect(score.sacred_regressions).toBeGreaterThan(0);
    expect(decideRollout(score)).toBe("block");
  });

  it("no baseline supplied -> no regressions -> the layer does not block on its own", () => {
    const score = computeScoreCard([j("c-sacred", "yes"), j("c-plain", "yes")], criteria, []);
    expect(score.sacred_regressions).toBe(0);
    expect(decideRollout(score)).toBe("ship");
  });
});

describe("baseline wiring — obsolete_review when the skill adds no value (#222)", () => {
  it("naked model matches the skill on all criteria -> isObsolete -> decideRollout = obsolete_review", () => {
    const withSkill = [j("c1", "yes"), j("c2", "yes")];
    const naked = [j("c1", "yes"), j("c2", "yes")]; // base model already passes everything
    const comparisons = compareBaseline(withSkill, naked);
    const isObsolete = isObsoleteCandidate(comparisons);
    expect(isObsolete).toBe(true);
    const score = computeScoreCard(withSkill, [], []);
    expect(decideRollout(score, isObsolete)).toBe("obsolete_review");
  });
});
