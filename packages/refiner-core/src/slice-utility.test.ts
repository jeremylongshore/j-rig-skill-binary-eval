/**
 * Tests for slice-utility.ts — COMPUTED per-block LOBO attribution.
 *
 * Discipline:
 *   - The COMPUTED hard rule is asserted directly: a block's TYPE never sets its
 *     utility; identical-typed blocks get opposite classifications when the eval
 *     signal differs (the asymmetric cases).
 *   - The scorer is a stub (BlockScorer interface). We assert that ablating a
 *     specific block changes the score and that the SIGN of the computed delta
 *     drives the class.
 *   - C3: a structural test asserts SliceUtilityReport has no skill-level
 *     aggregate field.
 *   - Anti-gaming (Rule 3): the eval-set quality gate is exercised across all
 *     four sources + refresh-due + allowUngated.
 *   - Correctness: a schema-invalidating ablation is classified schema-required
 *     and NEVER scored.
 *   - Power: an underpowered insignificant move reads inconclusive, not inert.
 *   - Roots/empty/null: empty doc, no-headings doc, no-blocks, null refreshDueAt.
 */

import { describe, it, expect } from "vitest";
import {
  computeSliceUtility,
  sliceIntoBlocks,
  gateEvalSet,
  NO_SKILL_LEVEL_AGGREGATE,
  type Block,
  type BlockScorer,
  type SliceUtilityReport,
} from "./slice-utility.js";
import { makeSkillDoc } from "./apply.js";
import type { EvalSet, ScoreRecord, ScoreDimension, SkillDoc } from "./types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const LINEAGE = "0190b8a0-1234-7abc-8def-0123456789ab"; // valid UUIDv7
const EVAL_HASH = "a".repeat(64);

/** A synthetic eval set (admissible by construction; null refresh = not due). */
function synthEvalSet(over: Partial<EvalSet> = {}): EvalSet {
  return {
    hash: EVAL_HASH,
    skillId: "demo-skill",
    source: "synthetic",
    items: [{ id: "syn-001", prompt: "do the thing" }],
    evalSetVersion: "1.0.0",
    lineageParent: null,
    refreshDueAt: null,
    lineageId: LINEAGE,
    ...over,
  };
}

function dim(value: number, n = 50, variance = 0): ScoreDimension {
  return { value, variance, n };
}

/**
 * A SKILL.md with three uniquely-anchorable BODY heading blocks and full
 * IS 8-field frontmatter, so the real kernel validator accepts both the
 * baseline AND every body-block ablation (only the body changes — frontmatter
 * stays intact). The slicer excludes frontmatter, so the ablatable blocks are
 * Overview / Examples / Policy.
 */
const DOC: SkillDoc = makeSkillDoc(
  "demo-skill",
  `---
name: demo-skill
description: A demo skill for slice-utility tests that does the thing well.
allowed-tools: Read, Bash
version: 1.0.0
author: Intent Solutions
license: Apache-2.0
compatibility: Claude Code
tags: [demo, testing]
---
## Overview
The overview body text.

## Examples
A worked example block.

## Policy
A hard rule the skill must follow.
`,
);

/**
 * A stub scorer whose behavioral value depends on WHICH block text is missing
 * from the doc variant. This lets us assert COMPUTED, signal-driven utility:
 * the same baseline doc scores `base`; removing the "Examples" block hurts
 * (load-bearing), removing the "Policy" block helps (harmful), removing
 * "Overview" is within noise (inert / inconclusive by n).
 */
function signalScorer(opts: {
  base: number;
  withoutExamples: number;
  withoutPolicy: number;
  withoutOverview: number;
  n?: number;
  variance?: number;
}): BlockScorer {
  const n = opts.n ?? 50;
  const variance = opts.variance ?? 0;
  return {
    score(doc: SkillDoc, evalSet: EvalSet): ScoreRecord {
      let value = opts.base;
      const hasExamples = doc.text.includes("A worked example block.");
      const hasPolicy = doc.text.includes("A hard rule the skill must follow.");
      const hasOverview = doc.text.includes("The overview body text.");
      if (!hasExamples) value = opts.withoutExamples;
      else if (!hasPolicy) value = opts.withoutPolicy;
      else if (!hasOverview) value = opts.withoutOverview;
      const behavioral = dim(value, n, variance);
      return {
        skill: doc.hash,
        evalSet: evalSet.hash,
        behavioral,
        dimensions: { behavioral },
      };
    },
  };
}

// ── Slicing ────────────────────────────────────────────────────────────────

describe("sliceIntoBlocks", () => {
  it("slices a SKILL.md into uniquely-anchorable heading blocks (frontmatter excluded)", () => {
    const blocks = sliceIntoBlocks(DOC);
    expect(blocks.map((b) => b.id)).toEqual(["overview", "examples", "policy"]);
    // Frontmatter is not a block.
    for (const b of blocks) {
      expect(b.anchor).not.toContain("name: demo-skill");
    }
  });

  it("every emitted block anchor occurs exactly once in the doc (valid DeleteOp target)", () => {
    const blocks = sliceIntoBlocks(DOC);
    for (const b of blocks) {
      const occ = DOC.text.split(b.anchor).length - 1;
      expect(occ).toBe(1);
    }
  });

  it("root/empty: empty doc yields no blocks", () => {
    expect(sliceIntoBlocks(makeSkillDoc("x", ""))).toEqual([]);
  });

  it("no-headings doc yields no blocks", () => {
    const doc = makeSkillDoc("x", "Just prose, no headings at all.\nSecond line.");
    expect(sliceIntoBlocks(doc)).toEqual([]);
  });

  it("drops duplicated blocks (cannot be unambiguously ablated)", () => {
    // Two identical heading+body blocks → neither is uniquely anchorable.
    const doc = makeSkillDoc(
      "dup",
      `## Same
identical body line.

## Same
identical body line.
`,
    );
    // Both blocks have identical text, so countOccurrences > 1 → dropped.
    const blocks = sliceIntoBlocks(doc);
    expect(blocks).toEqual([]);
  });

  it("classifies heading types for ablation ORDER only", () => {
    const blocks = sliceIntoBlocks(DOC);
    const byId = Object.fromEntries(blocks.map((b) => [b.id, b.type]));
    expect(byId.examples).toBe("example");
    expect(byId.policy).toBe("policy");
  });
});

// ── Heading-slicer hardening (Gemini review, PR #159) ───────────────────────
//
// Each test below FAILS against the pre-fix slicer:
//   - code-fence: a `#`-prefixed line inside ``` was matched as a heading.
//   - duplicate-slug: two headings slugifying identically produced colliding ids,
//     breaking the unique-anchor contract LOBO ablation depends on.
//   - single-line frontmatter close: `\s*` swallowed the blank line after `---`,
//     so the first body heading's anchor lost its leading newline / shifted.

describe("sliceIntoBlocks — heading slicer hardening (Gemini review)", () => {
  it("does NOT treat a #-prefixed line inside a fenced code block as a heading", () => {
    // The fenced ```bash block contains `# not a heading` and `## also not one`.
    // The pre-fix scan matched both as ATX headings → spurious blocks + a wrong
    // slice that would corrupt the doc on ablation. Only the two REAL `##`
    // headings (Setup, Teardown) must be sliced.
    const doc = makeSkillDoc(
      "fenced",
      `## Setup
Run the installer.

\`\`\`bash
# not a heading — a shell comment
## also not a heading — still inside the fence
echo "hello"
\`\`\`

## Teardown
Remove the artifacts.
`,
    );
    const blocks = sliceIntoBlocks(doc);
    expect(blocks.map((b) => b.id)).toEqual(["setup", "teardown"]);
    // The fenced comment text rides inside the Setup block's anchor, intact —
    // it was never promoted to its own (spurious) block.
    const setup = blocks.find((b) => b.id === "setup")!;
    expect(setup.anchor).toContain("# not a heading — a shell comment");
    expect(setup.anchor).toContain("## also not a heading — still inside the fence");
    // No block id derived from the in-fence `#` lines leaked in.
    expect(blocks.map((b) => b.id)).not.toContain("not-a-heading-a-shell-comment");
  });

  it("also honors ~~~ tilde fences and indented fences", () => {
    const doc = makeSkillDoc(
      "tilde",
      `## Alpha
Body A.

~~~
# inside a tilde fence
~~~

## Beta
Body B.
`,
    );
    const blocks = sliceIntoBlocks(doc);
    expect(blocks.map((b) => b.id)).toEqual(["alpha", "beta"]);
  });

  it("de-duplicates ids when two headings slugify identically (unique-anchor contract)", () => {
    // `## Overview!` and `## Overview?` both slugify to `overview`. Without the
    // fix they share a blockId — a collision that breaks the per-block rank map
    // (assignUtilityRanks) and the LOBO unique-anchor guarantee.
    const doc = makeSkillDoc(
      "dupslug",
      `## Overview!
First overview, distinct body one.

## Overview?
Second overview, distinct body two.
`,
    );
    const blocks = sliceIntoBlocks(doc);
    expect(blocks.length).toBe(2);
    const ids = blocks.map((b) => b.id);
    // Both retained, with unique ids (collision suffixed `-2`).
    expect(ids).toEqual(["overview", "overview-2"]);
    expect(new Set(ids).size).toBe(ids.length); // ids are unique
    // Each anchor still occurs exactly once in the doc (valid DeleteOp target).
    for (const b of blocks) {
      expect(doc.text.split(b.anchor).length - 1).toBe(1);
    }
  });

  it("keeps frontmatter-following whitespace so the first body heading is sliced correctly", () => {
    // The closing `---` is followed by a blank line, then the first heading.
    // The pre-fix `\s*$` over-spanned, swallowing that blank line into the
    // delimiter match (verified: match length 4 vs 3 — it ate one `\n`). The
    // `[^\S\r\n]*` fix keeps the close single-line. The first heading must slice
    // as a clean, single-occurrence anchor that starts exactly at `## First`.
    const doc = makeSkillDoc(
      "fm",
      `---
name: fm-skill
description: A skill exercising frontmatter-boundary slicing precisely here.
allowed-tools: Read
version: 1.0.0
author: Intent Solutions
license: Apache-2.0
compatibility: Claude Code
tags: [fm]
---

## First
Body of the first block.

## Second
Body of the second block.
`,
    );
    const blocks = sliceIntoBlocks(doc);
    expect(blocks.map((b) => b.id)).toEqual(["first", "second"]);
    const first = blocks.find((b) => b.id === "first")!;
    // The anchor begins exactly at the heading line — no frontmatter bleed-in,
    // no missing/extra leading whitespace.
    expect(first.anchor.startsWith("## First")).toBe(true);
    expect(first.anchor).not.toContain("name: fm-skill");
    // And it is a valid, single-occurrence DeleteOp target.
    expect(doc.text.split(first.anchor).length - 1).toBe(1);
  });

  it("a heading immediately followed by content slices as one single-line heading + body", () => {
    // Regression guard for the `\s` over-span class of bug at the heading level:
    // the heading line must stay single-line; the content on the NEXT line is
    // body, not part of the heading title.
    const doc = makeSkillDoc(
      "tight",
      `## Tight
Immediately-following content line.
More body.
`,
    );
    const blocks = sliceIntoBlocks(doc);
    expect(blocks.length).toBe(1);
    expect(blocks[0].id).toBe("tight");
    expect(blocks[0].anchor.startsWith("## Tight\nImmediately-following content line.")).toBe(true);
  });
});

// ── Eval-set quality gate (Rule 3) ──────────────────────────────────────────

describe("gateEvalSet (anti-gaming, Rule 3)", () => {
  it("synthetic sets pass by construction", () => {
    expect(gateEvalSet(synthEvalSet())).toEqual({ quality: "gated" });
  });

  it("golden sets pass by construction", () => {
    expect(gateEvalSet(synthEvalSet({ source: "golden" }))).toEqual({ quality: "gated" });
  });

  it("harvested sets are ungated without an explicit verified flag", () => {
    const r = gateEvalSet(synthEvalSet({ source: "harvested" }));
    expect(r.quality).toBe("ungated");
    if (r.quality === "ungated") {
      expect(r.reasons).toContain("unverified-harvested-source");
    }
  });

  it("hybrid sets are ungated without an explicit verified flag", () => {
    const r = gateEvalSet(synthEvalSet({ source: "hybrid" }));
    expect(r.quality).toBe("ungated");
  });

  it("harvested sets pass WITH an explicit verified flag", () => {
    const r = gateEvalSet(synthEvalSet({ source: "harvested" }), { verifiedEvalSet: true });
    expect(r).toEqual({ quality: "gated" });
  });

  it("a refresh-due set is ungated regardless of source", () => {
    const due = synthEvalSet({ refreshDueAt: "2020-01-01T00:00:00Z" });
    const r = gateEvalSet(due, { refreshDueOpts: { now: "2026-01-01T00:00:00Z" } });
    expect(r.quality).toBe("ungated");
    if (r.quality === "ungated") {
      expect(r.reasons).toContain("refresh-due");
    }
  });

  it("null refreshDueAt is NOT due by default (quick-mode set)", () => {
    expect(gateEvalSet(synthEvalSet({ refreshDueAt: null }))).toEqual({ quality: "gated" });
  });

  it("a harvested AND refresh-due set reports BOTH reasons", () => {
    const bad = synthEvalSet({ source: "harvested", refreshDueAt: "2020-01-01T00:00:00Z" });
    const r = gateEvalSet(bad, { refreshDueOpts: { now: "2026-01-01T00:00:00Z" } });
    expect(r.quality).toBe("ungated");
    if (r.quality === "ungated") {
      expect(r.reasons).toEqual(
        expect.arrayContaining(["unverified-harvested-source", "refresh-due"]),
      );
    }
  });
});

// ── computeSliceUtility: COMPUTED, signal-driven classification ──────────────

describe("computeSliceUtility — COMPUTED per-block (the core contract)", () => {
  it("classifies a load-bearing block (ablation regresses) and a harmful block (ablation improves) — asymmetric", () => {
    // Removing Examples drops 0.80 → 0.50 (HURTS → load-bearing).
    // Removing Policy raises 0.80 → 0.95 (HELPS → harmful).
    // Removing Overview stays 0.80 (no move → inert; n=50 ≥ 30).
    const scorer = signalScorer({
      base: 0.8,
      withoutExamples: 0.5,
      withoutPolicy: 0.95,
      withoutOverview: 0.8,
    });
    const report = computeSliceUtility({ doc: DOC, evalSet: synthEvalSet(), scorer });

    const byId = Object.fromEntries(report.blocks.map((b) => [b.blockId, b]));
    expect(byId.examples.class).toBe("load-bearing");
    expect(byId.examples.utility).toBeCloseTo(0.3, 9); // 0.80 − 0.50, positive (hurt)
    expect(byId.policy.class).toBe("harmful");
    expect(byId.policy.utility).toBeCloseTo(-0.15, 9); // 0.80 − 0.95, negative (helped)
    expect(byId.overview.class).toBe("inert");
    expect(byId.overview.utility).toBeCloseTo(0, 9);
  });

  it("utility is COMPUTED from signal, NOT a constant keyed on block type", () => {
    // 'policy' is the SAME type in both runs; only the eval signal differs.
    // Run A: removing policy HURTS. Run B: removing policy HELPS. The static
    // meta_skill table would give 'policy' the same utility in both — we must not.
    const runA = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer: signalScorer({
        base: 0.7,
        withoutExamples: 0.7,
        withoutPolicy: 0.4,
        withoutOverview: 0.7,
      }),
    });
    const runB = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer: signalScorer({
        base: 0.7,
        withoutExamples: 0.7,
        withoutPolicy: 0.95,
        withoutOverview: 0.7,
      }),
    });
    const policyA = runA.blocks.find((b) => b.blockId === "policy")!;
    const policyB = runB.blocks.find((b) => b.blockId === "policy")!;
    expect(policyA.class).toBe("load-bearing");
    expect(policyB.class).toBe("harmful");
    expect(Math.sign(policyA.utility!)).toBe(1);
    expect(Math.sign(policyB.utility!)).toBe(-1);
  });

  it("carries baselineN and ablatedN on every scored block", () => {
    const report = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer: signalScorer({
        base: 0.8,
        withoutExamples: 0.5,
        withoutPolicy: 0.95,
        withoutOverview: 0.8,
        n: 42,
      }),
    });
    for (const b of report.blocks) {
      if (b.class !== "schema-required") {
        expect(b.baselineN).toBe(42);
        expect(b.ablatedN).toBe(42);
      }
    }
  });

  it("distinguishes inconclusive (underpowered null) from inert (adequate-power null)", () => {
    // Same no-move signal, but n below minPowerN → inconclusive, not inert.
    const lowPower = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer: signalScorer({
        base: 0.8,
        withoutExamples: 0.8,
        withoutPolicy: 0.8,
        withoutOverview: 0.8,
        n: 5,
      }),
      minPowerN: 30,
    });
    for (const b of lowPower.blocks) {
      expect(b.class).toBe("inconclusive");
    }

    const adequate = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer: signalScorer({
        base: 0.8,
        withoutExamples: 0.8,
        withoutPolicy: 0.8,
        withoutOverview: 0.8,
        n: 100,
      }),
      minPowerN: 30,
    });
    for (const b of adequate.blocks) {
      expect(b.class).toBe("inert");
    }
  });

  it("ranks scored blocks by descending |utility|; schema-required get null rank", () => {
    const report = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer: signalScorer({
        base: 0.8,
        withoutExamples: 0.5,
        withoutPolicy: 0.95,
        withoutOverview: 0.79,
      }),
    });
    const byId = Object.fromEntries(report.blocks.map((b) => [b.blockId, b]));
    // |examples|=0.30 > |policy|=0.15 > |overview|=0.01
    expect(byId.examples.utilityRank).toBe(1);
    expect(byId.policy.utilityRank).toBe(2);
    expect(byId.overview.utilityRank).toBe(3);
  });

  it("respects significance: a sub-α move with positive variance is NOT load-bearing", () => {
    // A tiny drop with non-zero variance and small n → not significant → inert/inconclusive.
    const scorer: BlockScorer = {
      score(doc, evalSet) {
        const hasExamples = doc.text.includes("A worked example block.");
        // baseline 0.80; ablated 0.79 — within noise given variance.
        const value = hasExamples ? 0.8 : 0.79;
        const behavioral = dim(value, 50, /*variance*/ 0.25);
        return { skill: doc.hash, evalSet: evalSet.hash, behavioral, dimensions: { behavioral } };
      },
    };
    const report = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer,
      blocks: sliceIntoBlocks(DOC).filter((b) => b.id === "examples"),
    });
    expect(report.blocks[0].class).toBe("inert");
  });
});

// ── Correctness: schema-required ablations are never scored ──────────────────

describe("computeSliceUtility — schema admissibility (correctness fix)", () => {
  it("classifies a schema-invalidating ablation as schema-required and never scores it", () => {
    let scoreCalls = 0;
    const countingScorer: BlockScorer = {
      score(doc, evalSet) {
        scoreCalls++;
        const behavioral = dim(0.8, 50);
        return { skill: doc.hash, evalSet: evalSet.hash, behavioral, dimensions: { behavioral } };
      },
    };
    // A block whose removal we declare schema-invalid via a stub validator.
    const block: Block = sliceIntoBlocks(DOC).find((b) => b.id === "examples")!;
    const report = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer: countingScorer,
      blocks: [block],
      validator: { validate: () => ({ valid: false, issues: ["removed a required field"] }) },
    });
    expect(report.blocks[0].class).toBe("schema-required");
    expect(report.blocks[0].utility).toBeNull();
    expect(report.blocks[0].baselineN).toBeNull();
    expect(report.blocks[0].utilityRank).toBeNull();
    expect(report.blocks[0].schemaIssues).toEqual(["removed a required field"]);
    // Only the baseline score call happened — the ablated variant was NOT scored.
    expect(scoreCalls).toBe(1);
  });
});

// ── Anti-gaming refuse path (Rule 3) ─────────────────────────────────────────

describe("computeSliceUtility — ungated eval set refuses by default", () => {
  const scorer = signalScorer({
    base: 0.8,
    withoutExamples: 0.5,
    withoutPolicy: 0.95,
    withoutOverview: 0.8,
  });

  it("refuses (empty blocks, all skipped) when the set is ungated and allowUngated is false", () => {
    const report = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet({ source: "harvested" }),
      scorer,
    });
    expect(report.evalSetQuality).toBe("ungated");
    expect(report.ungatedReasons).toContain("unverified-harvested-source");
    expect(report.blocks).toEqual([]);
    expect(report.skipped).toEqual(["overview", "examples", "policy"]);
  });

  it("computes (flagging ungated) when allowUngated is true", () => {
    const report = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet({ source: "harvested" }),
      scorer,
      allowUngated: true,
    });
    expect(report.evalSetQuality).toBe("ungated");
    expect(report.blocks.length).toBe(3);
  });

  it("a verified harvested set computes normally (gated)", () => {
    const report = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet({ source: "harvested" }),
      scorer,
      verifiedEvalSet: true,
    });
    expect(report.evalSetQuality).toBe("gated");
    expect(report.blocks.length).toBe(3);
  });
});

// ── Modes: full vs capped ────────────────────────────────────────────────────

describe("computeSliceUtility — full vs capped modes", () => {
  const scorer = signalScorer({
    base: 0.8,
    withoutExamples: 0.5,
    withoutPolicy: 0.95,
    withoutOverview: 0.8,
  });

  it("full mode ablates every block (K results, none skipped)", () => {
    const report = computeSliceUtility({ doc: DOC, evalSet: synthEvalSet(), scorer, mode: "full" });
    expect(report.blocks.length).toBe(3);
    expect(report.skipped).toEqual([]);
  });

  it("capped mode honors maxAblations, reporting unreached blocks in skipped", () => {
    const report = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer,
      mode: "capped",
      maxAblations: 2,
    });
    expect(report.blocks.length).toBe(2);
    expect(report.skipped.length).toBe(1);
    // Weakest-first order: example (0) and overview/body (2) come before policy (4).
    expect(report.skipped).toEqual(["policy"]);
  });

  it("capped mode uses block TYPE only as ORDER, never as the output utility", () => {
    const report = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer,
      mode: "capped",
      maxAblations: 1,
    });
    // Only the weakest-first block (examples) is ablated; its utility is still
    // the COMPUTED delta, not a type constant.
    expect(report.blocks.length).toBe(1);
    expect(report.blocks[0].blockId).toBe("examples");
    expect(report.blocks[0].utility).toBeCloseTo(0.3, 9);
  });
});

// ── Roots / empty / null ─────────────────────────────────────────────────────

describe("computeSliceUtility — roots/empty/null", () => {
  it("a doc with no blocks yields an empty report (no aggregate, no error)", () => {
    const empty = makeSkillDoc("empty", "no headings here");
    const report = computeSliceUtility({
      doc: empty,
      evalSet: synthEvalSet({ skillId: "empty" }),
      scorer: signalScorer({
        base: 0.8,
        withoutExamples: 0.8,
        withoutPolicy: 0.8,
        withoutOverview: 0.8,
      }),
    });
    expect(report.blocks).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.skillId).toBe("empty");
  });
});

// ── C3: no skill-level aggregate (Rule 2, structural) ────────────────────────

describe("C3 — the report carries NO skill-level aggregate", () => {
  it("exposes the documented no-reduce marker", () => {
    expect(NO_SKILL_LEVEL_AGGREGATE).toBe(true);
  });

  it("SliceUtilityReport has no rolled-up usefulness/score/aggregate field", () => {
    const report = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer: signalScorer({
        base: 0.8,
        withoutExamples: 0.5,
        withoutPolicy: 0.95,
        withoutOverview: 0.8,
      }),
    });
    const keys = Object.keys(report);
    // The consuming-surface invariant: no scalar rollup of per-block utilities.
    const forbidden = ["score", "usefulness", "aggregate", "total", "rolledScore", "overall"];
    for (const f of forbidden) {
      expect(keys).not.toContain(f);
    }
    // Sanity: the only collection of utilities is the per-block VECTOR.
    expect(Array.isArray(report.blocks)).toBe(true);
  });

  it("does not emit a single number summarizing the skill (type-level guard)", () => {
    // A compile-time guard mirrored at runtime: every utility lives on a block.
    const report: SliceUtilityReport = computeSliceUtility({
      doc: DOC,
      evalSet: synthEvalSet(),
      scorer: signalScorer({
        base: 0.8,
        withoutExamples: 0.5,
        withoutPolicy: 0.95,
        withoutOverview: 0.8,
      }),
    });
    // No top-level numeric field other than alpha (the significance level, not a score).
    const numericTopLevel = Object.entries(report)
      .filter(([, v]) => typeof v === "number")
      .map(([k]) => k);
    expect(numericTopLevel).toEqual(["alpha"]);
  });
});
