/**
 * slice-utility.ts — COMPUTED per-block utility via Leave-One-Block-Out (LOBO)
 * causal attribution (epic intent-eval-lab#206, bead bd_000-projects-ig4h.3).
 *
 * # What this is
 *
 * A block's utility is the **measured counterfactual effect of removing it** —
 * the signed change in the behavioral eval score when that block is ablated,
 * judged at the SAME α=0.05 significance bar the acceptance gate already uses
 * (`isSignificantRegression` / `isSignificantImprovement` in accept.ts).
 *
 * This is the deliberate INVERSE of the meta_skill anti-pattern (a const table
 * keyed on block type — `Policy = 0.95` by fiat). Here a block's *type* is
 * never its utility. Its utility is the demonstrated effect of its presence,
 * computed from real eval signal:
 *
 *   - removing the block significantly DROPS the score → `load-bearing`
 *     (the block carries weight; cutting it regresses behavior).
 *   - removing the block significantly IMPROVES the score → `harmful`
 *     (a cut candidate — the block was hurting).
 *   - removing the block moves the score within noise → `inert` (adequate n)
 *     or `inconclusive` (underpowered — a low-power null is NOT a computed zero).
 *   - ablation makes the doc schema-invalid → `schema-required` (utility: null,
 *     never scored — removing it is structurally inadmissible).
 *
 * # Hard rules honored (per the build-ready design spec, Item 3)
 *
 *   - **Compute-not-constant (Rule 1):** utility is `baseline − ablated`,
 *     measured per block. No static constant keyed on block type lives here.
 *   - **C3 — no rolled score (Rule 2):** the report is a per-block VECTOR. There
 *     is deliberately NO report-level aggregate / "usefulness %" field. The
 *     {@link NO_SKILL_LEVEL_AGGREGATE} marker documents this; a consuming-surface
 *     test asserts no scalar rollup is emitted.
 *   - **Anti-gaming (Rule 3):** eval-set quality is a precondition. A
 *     `harvested`/`hybrid` set without an explicit verified flag, or a
 *     refresh-due set, is `ungated` — the whole computation refuses (or flags,
 *     under `allowUngated`) rather than producing trustworthy-looking numbers
 *     off a gameable set.
 *   - **Kernel-additive (Rule 4):** this stays pure refiner-core. `BlockUtility`
 *     is NOT a kernel entity and this module emits NO signed bundle row. Any
 *     kernel routing is a separate, gated bead with its own DR.
 *
 * # Two ablation modes
 *
 *   - **full-LOBO** (`mode: "full"`): ablate every block (K+1 scorer calls — 1
 *     baseline + K ablations). Complete, K-bounded.
 *   - **weakest-first / capped** (`mode: "capped"` + `maxAblations`): the
 *     meta_skill static-type bias is admissible ONLY as ablation ORDER (which
 *     blocks to try first under a budget), NEVER as the output utility. Blocks
 *     not reached under the cap are reported in `skipped`.
 *
 * LOBO is a FIRST-ORDER approximation: two blocks that only matter together each
 * look inert when ablated singly. True Shapley is 2^K and out of scope (a wave-2
 * pairwise opt-in). This limitation is documented, not hidden.
 *
 * Sources:
 *   - /tmp/scoring-spec.md Item 3 — slice_utility (refiner-core, COMPUTED per-block)
 *   - intent-eval-lab#206 (epic)
 *   - accept.ts: isSignificantRegression / isSignificantImprovement (the α=0.05 bar)
 *   - eval-set.ts: isRefreshDue (staleness gate)
 *   - eval-set-metrics.ts: evaluateEvalSet (quality report)
 *   - schema-validator.ts: kernelSkillFrontmatterValidator (ablation admissibility)
 */

import type { SkillDoc, EditProposal, EvalSet, ScoreRecord, ScoreDimension } from "./types.js";
import { applyEdit } from "./apply.js";
import { isSignificantImprovement, isSignificantRegression } from "./accept.js";
import { isRefreshDue, type IsRefreshDueOptions } from "./eval-set.js";
import { kernelSkillFrontmatterValidator, type SchemaValidator } from "./schema-validator.js";
import { DEFAULT_ALPHA } from "./types.js";

// ── No-reduce marker (C3, Rule 2) ───────────────────────────────────────────

/**
 * Documented structural marker: this module NEVER reduces per-block utilities
 * into a single skill-level scalar (no "usefulness %", no headline score).
 *
 * The C3 defense is the ABSENCE of a rollup field on {@link SliceUtilityReport}
 * (there is no `score` / `aggregate` / `usefulness` field by construction), not
 * a regex. A consuming-surface test asserts this marker stays true.
 */
export const NO_SKILL_LEVEL_AGGREGATE = true as const;

// ── Block ────────────────────────────────────────────────────────────────────

/**
 * A uniquely-anchorable span of a SKILL.md — a valid `DeleteOp` target per
 * apply.ts `requireUnique` (appears exactly once in the doc text). A block is
 * the unit of ablation: removing it is the counterfactual whose effect is the
 * block's utility.
 */
export interface Block {
  /** Stable identifier for the block (e.g. its heading slug, or an index). */
  readonly id: string;
  /**
   * The exact substring removed when this block is ablated. MUST appear exactly
   * once in the doc text (a valid, unambiguous `DeleteOp` target). The slicer
   * guarantees uniqueness; callers supplying their own blocks must too.
   */
  readonly anchor: string;
  /**
   * Optional coarse block-TYPE label (e.g. "policy", "example", "trigger").
   * Used ONLY as ablation ORDER in capped mode (the meta_skill static bias is
   * admissible as ordering, never as the output utility). Never read as a score.
   */
  readonly type?: string;
}

// ── BlockScorer seam ─────────────────────────────────────────────────────────

/**
 * Injectable scoring seam — keeps this module PURE (no model client, no I/O, no
 * `Date.now()`). Production wires a j-rig shell-out adapter; tests pass a stub.
 *
 * The scorer MUST score the supplied doc variant against the SAME frozen eval
 * set every time (the caller passes the eval set in; the scorer closes over the
 * frozen items). It MUST be deterministic for a given (doc, evalSet) pair so the
 * LOBO attribution is replayable.
 */
export interface BlockScorer {
  /**
   * Score a SKILL.md variant against the frozen eval set.
   *
   * @param doc     - the (possibly ablated) SKILL.md variant.
   * @param evalSet - the frozen eval set the baseline was scored against.
   * @returns a ScoreRecord whose `behavioral` dimension carries value+variance+n.
   */
  score(doc: SkillDoc, evalSet: EvalSet): ScoreRecord;
}

// ── Eval-set quality gate (Rule 3) ───────────────────────────────────────────

/**
 * Quality verdict on the eval set the LOBO attribution is derived against.
 *
 * - `synthetic` / `golden` sets are admissible BY CONSTRUCTION (deterministic,
 *   author-curated) and pass the gate.
 * - `harvested` / `hybrid` sets are `ungated` UNLESS the caller passes an
 *   explicit `verifiedEvalSet: true` flag (a human asserted the harvested set
 *   was vetted).
 * - ANY set that is refresh-due (`isRefreshDue`) is `ungated` regardless of
 *   source — a stale set is not trustworthy evidence.
 */
export type EvalSetQuality = "gated" | "ungated";

/** Why an eval set was classified `ungated` (for the report + audit trail). */
export type UngatedReason =
  /** `harvested`/`hybrid` source without an explicit `verifiedEvalSet` flag. */
  | "unverified-harvested-source"
  /** `isRefreshDue` returned true — the set is stale. */
  | "refresh-due";

/** Result of {@link gateEvalSet}. */
export type EvalSetGateResult =
  | { readonly quality: "gated" }
  | { readonly quality: "ungated"; readonly reasons: readonly UngatedReason[] };

/**
 * Classify an eval set's trustworthiness for LOBO attribution (Rule 3).
 *
 * Reuses the already-exported `isRefreshDue` (staleness) — no new staleness
 * machinery. Synthetic/golden pass by construction; harvested/hybrid require an
 * explicit verified flag; any refresh-due set is ungated.
 *
 * @param evalSet - the frozen eval set.
 * @param opts    - `verifiedEvalSet` to vouch a harvested/hybrid set;
 *                  `refreshDueOpts` forwarded to `isRefreshDue` (e.g. injected `now`).
 */
export function gateEvalSet(
  evalSet: EvalSet,
  opts: { readonly verifiedEvalSet?: boolean; readonly refreshDueOpts?: IsRefreshDueOptions } = {},
): EvalSetGateResult {
  const reasons: UngatedReason[] = [];

  const sourceNeedsVouch = evalSet.source === "harvested" || evalSet.source === "hybrid";
  if (sourceNeedsVouch && opts.verifiedEvalSet !== true) {
    reasons.push("unverified-harvested-source");
  }

  if (isRefreshDue(evalSet, opts.refreshDueOpts ?? {})) {
    reasons.push("refresh-due");
  }

  if (reasons.length === 0) {
    return { quality: "gated" };
  }
  return { quality: "ungated", reasons };
}

// ── Per-block utility ─────────────────────────────────────────────────────────

/**
 * Computed utility classification for a block.
 *
 *   - `load-bearing`   — ablation SIGNIFICANTLY regressed behavioral (block carries weight).
 *   - `harmful`        — ablation SIGNIFICANTLY improved behavioral (cut candidate).
 *   - `inert`          — no significant move AND adequate sample power.
 *   - `inconclusive`   — no significant move but the sample was underpowered
 *                        (a low-power null, NOT a computed zero).
 *   - `schema-required`— ablation made the doc schema-invalid; not scored
 *                        (removing the block is structurally inadmissible).
 */
export type BlockUtilityClass =
  | "load-bearing"
  | "harmful"
  | "inert"
  | "inconclusive"
  | "schema-required";

/**
 * The COMPUTED per-block utility record. Carries the SIGNED `utility` delta plus
 * the sample counts behind both sides so a low-power null is distinguishable
 * from a true zero (statistical-power fix).
 */
export interface BlockUtility {
  /** The block this utility is for. */
  readonly blockId: string;
  /** Coarse block type, when supplied (audit only — never the score). */
  readonly blockType: string | null;
  /** Computed classification. */
  readonly class: BlockUtilityClass;
  /**
   * Signed utility delta: `baseline.behavioral.value − ablated.behavioral.value`.
   * Positive ⇒ removing the block HURT (the block was load-bearing).
   * Negative ⇒ removing the block HELPED (the block was harmful).
   * `null` ⇒ the block was not scored (`schema-required`).
   */
  readonly utility: number | null;
  /** Sample count behind the baseline behavioral estimate (≥ 1), or null if unscored. */
  readonly baselineN: number | null;
  /** Sample count behind the ablated behavioral estimate (≥ 1), or null if unscored. */
  readonly ablatedN: number | null;
  /**
   * 1-based rank by descending |utility| among SCORED blocks (1 = highest
   * absolute effect). `null` for unscored (`schema-required`) blocks, which have
   * no comparable magnitude.
   */
  readonly utilityRank: number | null;
  /**
   * Schema issues from the kernel validator when `class === "schema-required"`.
   * Empty for scored blocks.
   */
  readonly schemaIssues: readonly string[];
}

/**
 * The per-block utility VECTOR. Deliberately carries NO skill-level aggregate
 * (C3, Rule 2): there is no `score` / `usefulness` / `aggregate` field — the
 * absence is the structural C3 defense. {@link NO_SKILL_LEVEL_AGGREGATE} marks it.
 */
export interface SliceUtilityReport {
  /** kebab-slug skill id the report is for. */
  readonly skillId: string;
  /** Eval-set quality verdict (Rule 3). `ungated` ⇒ `blocks` is empty unless `allowUngated`. */
  readonly evalSetQuality: EvalSetQuality;
  /** Reasons the eval set was ungated (empty when `gated`). */
  readonly ungatedReasons: readonly UngatedReason[];
  /** Per-block utilities (one entry per scored OR schema-required block). */
  readonly blocks: readonly BlockUtility[];
  /**
   * Block ids NOT processed: blocks skipped under a `maxAblations` cap (capped
   * mode), or all blocks when the eval set was `ungated` and not allowed.
   */
  readonly skipped: readonly string[];
  /** Significance level used (default 0.05). */
  readonly alpha: number;
}

// ── Slicing ────────────────────────────────────────────────────────────────

/**
 * Slice a SKILL.md into uniquely-anchorable blocks at markdown heading
 * boundaries (a block = a heading line plus its body, up to the next heading of
 * the same-or-shallower depth, EXCLUDING frontmatter).
 *
 * `#`-prefixed lines INSIDE fenced code blocks (``` / ~~~) are NOT treated as
 * headings — a shell/python comment is body text, not a section boundary. Block
 * ids are de-duplicated (collisions get a `-2`, `-3`, … suffix) so every emitted
 * id is unique within the doc.
 *
 * Each emitted block's `anchor` is guaranteed to appear EXACTLY ONCE in the doc
 * text (a valid, unambiguous `DeleteOp` target per apply.ts `requireUnique`).
 * Blocks whose verbatim text is duplicated elsewhere are dropped (they cannot be
 * unambiguously ablated) and surfaced via the caller's `skipped` accounting is
 * not needed here — they simply are not anchorable units.
 *
 * Frontmatter (the leading `---`…`---` block) is intentionally NOT sliced: it is
 * not free-form prose and removing required fields is handled by the schema
 * admissibility check, not by treating frontmatter as an ablatable block.
 *
 * This is a pragmatic default slicer. Callers with a richer block model may
 * build {@link Block} values themselves and call {@link computeSliceUtility}
 * directly — the slicer is a convenience, not a hard dependency.
 */
export function sliceIntoBlocks(doc: SkillDoc): readonly Block[] {
  const body = stripFrontmatter(doc.text);

  // Collect heading positions in the BODY via a per-line scan (NOT a combined
  // `/^(#{1,6})\s+(.*)$/gm` regex — that form trips CodeQL `js/polynomial-redos`
  // because the `\s+` can backtrack against the trailing `.*` on a whitespace-
  // heavy line). `parseHeadingLine` matches each line with bounded, anchored
  // logic and no catastrophic backtracking.
  //
  // A line inside a fenced code block (between ``` / ~~~ fences) is NEVER a
  // heading: a `#`-prefixed comment in a bash/python/config example is body
  // text, not a section boundary. Matching it would slice the doc wrongly and
  // corrupt the document when that "block" is ablated. `isFenceLine` toggles the
  // in-fence state; while inside a fence, heading detection is suppressed.
  const heads: { index: number; depth: number; title: string }[] = [];
  let inCodeFence = false;
  let lineStart = 0;
  while (lineStart <= body.length) {
    let lineEnd = body.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = body.length;
    const line = body.slice(lineStart, lineEnd);
    if (isFenceLine(line)) {
      inCodeFence = !inCodeFence;
    } else if (!inCodeFence) {
      const parsed = parseHeadingLine(line);
      if (parsed !== null) {
        heads.push({ index: lineStart, depth: parsed.depth, title: parsed.title });
      }
    }
    lineStart = lineEnd + 1;
    if (lineEnd === body.length) break;
  }

  if (heads.length === 0) return [];

  // De-duplicate block ids: two headings that slugify identically (e.g.
  // `## Overview!` and `## Overview?` both → `overview`) MUST NOT share a
  // `blockId`. A non-unique id collides in `assignUtilityRanks` (the rank map
  // keys on blockId) and breaks per-block Leave-One-Block-Out attribution — the
  // anchor uniqueness the Block contract promises is load-bearing. On collision
  // we suffix `-2`, `-3`, … so every emitted id is unique within the doc.
  const rawBlocks: { id: string; anchor: string; type?: string }[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index;
    // A block extends to the next heading of same-or-shallower depth.
    let end = body.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].depth <= heads[i].depth) {
        end = heads[j].index;
        break;
      }
    }
    // `.trimEnd()` (not a `/\s+$/` regex) — built-in, linear-time, no ReDoS.
    const anchor = body.slice(start, end).trimEnd();
    const id = uniqueId(slugifyHeading(heads[i].title, i), seenIds);
    rawBlocks.push({ id, anchor, type: classifyHeading(heads[i].title) });
  }

  // Keep ONLY uniquely-anchorable blocks (valid DeleteOp targets).
  const blocks: Block[] = [];
  for (const b of rawBlocks) {
    if (b.anchor.length > 0 && countOccurrences(doc.text, b.anchor) === 1) {
      blocks.push({ id: b.id, anchor: b.anchor, type: b.type });
    }
  }
  return blocks;
}

// ── Core: computeSliceUtility (the COMPUTED LOBO function) ───────────────────

/** Mode for {@link computeSliceUtility}. */
export type SliceMode = "full" | "capped";

/** Options for {@link computeSliceUtility}. */
export interface ComputeSliceUtilityOptions {
  /** The skill doc to attribute (the un-ablated baseline). */
  readonly doc: SkillDoc;
  /** The frozen eval set the baseline is scored against. */
  readonly evalSet: EvalSet;
  /** Injectable scorer (production: j-rig adapter; tests: stub). */
  readonly scorer: BlockScorer;
  /**
   * Blocks to attribute. When omitted, {@link sliceIntoBlocks} is run on `doc`.
   * Every block's `anchor` MUST be a unique substring of `doc.text`.
   */
  readonly blocks?: readonly Block[];
  /**
   * Ablation mode. `"full"` (default) ablates every block (K+1 scorer calls).
   * `"capped"` ablates at most `maxAblations` blocks in weakest-first order.
   */
  readonly mode?: SliceMode;
  /** Cap for `mode: "capped"` (ignored in `"full"`). Default: all blocks. */
  readonly maxAblations?: number;
  /** Significance level (default 0.05 — the same bar accept.ts uses). */
  readonly alpha?: number;
  /**
   * Minimum sample count for a non-significant null to read as `inert` rather
   * than `inconclusive`. Below this, an insignificant move is underpowered.
   * Default: 30 (a conventional "adequate n" floor).
   */
  readonly minPowerN?: number;
  /**
   * Vouch a `harvested`/`hybrid` eval set as human-verified (Rule 3). Without
   * this, harvested/hybrid sets are `ungated`.
   */
  readonly verifiedEvalSet?: boolean;
  /**
   * When the eval set is `ungated`, still compute (flagging the report
   * `ungated`) instead of refusing. Default `false` (refuse: empty `blocks`,
   * all block ids in `skipped`).
   */
  readonly allowUngated?: boolean;
  /** Forwarded to `isRefreshDue` (e.g. injected `now` for deterministic tests). */
  readonly refreshDueOpts?: IsRefreshDueOptions;
  /**
   * Schema validator deciding ablation admissibility. Default:
   * `kernelSkillFrontmatterValidator()` (the kernel IS 8-field tier). Tests may
   * inject a stub.
   */
  readonly validator?: SchemaValidator;
}

/**
 * Compute per-block utility via Leave-One-Block-Out causal attribution.
 *
 * Algorithm per block B (reusing existing machinery only):
 *   1. Build a `DeleteOp{ target: B.anchor }`, wrap in a synthetic EditProposal.
 *   2. `applyEdit(doc, proposal)` → ablated variant.
 *   3. Schema-check the ablated variant FIRST. Invalid ⇒ `schema-required`
 *      (utility: null), never scored.
 *   4. Score the variant against the SAME frozen eval set (injected scorer).
 *   5. `delta = baseline.behavioral.value − ablated.behavioral.value`; classify
 *      via `isSignificantRegression` / `isSignificantImprovement` at α.
 *
 * Returns a per-block VECTOR with NO skill-level aggregate (C3).
 */
export function computeSliceUtility(opts: ComputeSliceUtilityOptions): SliceUtilityReport {
  const { doc, evalSet, scorer, mode = "full", alpha = DEFAULT_ALPHA, minPowerN = 30 } = opts;
  const validator = opts.validator ?? kernelSkillFrontmatterValidator();

  const allBlocks = opts.blocks ?? sliceIntoBlocks(doc);

  // ── Rule 3: eval-set quality gate ──────────────────────────────────────────
  const gate = gateEvalSet(evalSet, {
    verifiedEvalSet: opts.verifiedEvalSet,
    refreshDueOpts: opts.refreshDueOpts,
  });
  const ungatedReasons = gate.quality === "ungated" ? gate.reasons : [];

  if (gate.quality === "ungated" && opts.allowUngated !== true) {
    // Refuse: do not produce trustworthy-looking numbers off a gameable set.
    return {
      skillId: doc.skillId,
      evalSetQuality: "ungated",
      ungatedReasons,
      blocks: [],
      skipped: allBlocks.map((b) => b.id),
      alpha,
    };
  }

  // ── Decide ablation set + order ────────────────────────────────────────────
  // Capped mode uses block TYPE only as ORDER (weakest-first), never as score.
  const ordered = mode === "capped" ? orderWeakestFirst(allBlocks) : allBlocks;
  const cap = mode === "capped" ? (opts.maxAblations ?? ordered.length) : ordered.length;
  const toAblate = ordered.slice(0, Math.max(0, cap));
  const skipped = ordered.slice(Math.max(0, cap)).map((b) => b.id);

  // ── Baseline score (once) ──────────────────────────────────────────────────
  const baseline = scorer.score(doc, evalSet);

  // ── Per-block LOBO ─────────────────────────────────────────────────────────
  const raw: Omit<BlockUtility, "utilityRank">[] = [];
  for (const block of toAblate) {
    const proposal = makeAblationProposal(doc, block);
    const ablatedDoc = applyEdit(doc, proposal);

    // Correctness fix: schema-check the ablated variant BEFORE scoring it.
    const schema = validator.validate(ablatedDoc.text);
    if (!schema.valid) {
      raw.push({
        blockId: block.id,
        blockType: block.type ?? null,
        class: "schema-required",
        utility: null,
        baselineN: null,
        ablatedN: null,
        schemaIssues: schema.issues,
      });
      continue;
    }

    const ablated = scorer.score(ablatedDoc, evalSet);
    raw.push(classifyBlock(block, baseline.behavioral, ablated.behavioral, alpha, minPowerN));
  }

  // ── Rank scored blocks by descending |utility| ─────────────────────────────
  const blocks = assignUtilityRanks(raw);

  return {
    skillId: doc.skillId,
    evalSetQuality: gate.quality,
    ungatedReasons,
    blocks,
    skipped,
    alpha,
  };
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Classify one block from the baseline + ablated behavioral dimensions.
 * The delta is SIGNED and COMPUTED; significance uses the SAME accept.ts bar.
 */
function classifyBlock(
  block: Block,
  baselineDim: ScoreDimension,
  ablatedDim: ScoreDimension,
  alpha: number,
  minPowerN: number,
): Omit<BlockUtility, "utilityRank"> {
  // utility = baseline − ablated. Positive ⇒ removing the block HURT.
  const utility = baselineDim.value - ablatedDim.value;

  // Removing the block significantly REGRESSED behavioral ⇒ the block is
  // load-bearing. `isSignificantRegression(ablated, baseline)` asks "is the
  // ablated variant significantly LESS than baseline?" — exactly the test.
  const regressed = isSignificantRegression(ablatedDim, baselineDim, alpha);
  // Removing the block significantly IMPROVED behavioral ⇒ the block is harmful.
  const improved = isSignificantImprovement(ablatedDim, baselineDim, alpha);

  let cls: BlockUtilityClass;
  if (regressed) {
    cls = "load-bearing";
  } else if (improved) {
    cls = "harmful";
  } else {
    // No significant move. Distinguish adequate-power inert from underpowered
    // inconclusive (a low-power null must NOT read as a computed zero).
    const adequatePower = baselineDim.n >= minPowerN && ablatedDim.n >= minPowerN;
    cls = adequatePower ? "inert" : "inconclusive";
  }

  return {
    blockId: block.id,
    blockType: block.type ?? null,
    class: cls,
    utility,
    baselineN: baselineDim.n,
    ablatedN: ablatedDim.n,
    schemaIssues: [],
  };
}

/**
 * Assign 1-based `utilityRank` by descending |utility| among SCORED blocks.
 * `schema-required` blocks (utility null) get rank null. Ties break by blockId
 * for determinism.
 */
function assignUtilityRanks(
  raw: readonly Omit<BlockUtility, "utilityRank">[],
): readonly BlockUtility[] {
  const scored = raw
    .filter((b): b is Omit<BlockUtility, "utilityRank"> & { utility: number } => b.utility !== null)
    .slice()
    .sort((a, b) => {
      const d = Math.abs(b.utility) - Math.abs(a.utility);
      return d !== 0 ? d : a.blockId.localeCompare(b.blockId);
    });

  const rankById = new Map<string, number>();
  scored.forEach((b, i) => rankById.set(b.blockId, i + 1));

  return raw.map((b) => ({ ...b, utilityRank: rankById.get(b.blockId) ?? null }));
}

/** Build the synthetic single-DeleteOp EditProposal that ablates `block`. */
function makeAblationProposal(doc: SkillDoc, block: Block): EditProposal {
  return {
    parent: doc.hash,
    ops: [{ kind: "delete", target: block.anchor }],
    refinerModel: "slice-utility-lobo",
    refinerStrategyId: "slice-utility-lobo-v1",
    rationale: `LOBO ablation of block "${block.id}" for causal utility attribution.`,
  };
}

/**
 * Order blocks weakest-first for capped mode. The meta_skill static-type bias is
 * admissible ONLY here, as ABLATION ORDER — blocks whose type heuristically
 * suggests lower utility are tried first under the budget. This NEVER becomes the
 * output utility (the output is always the computed delta).
 *
 * Heuristic weakest-first priority (lower = tried first): example/note < body <
 * trigger < policy. Unknown types sort in the middle. Ties → blockId.
 */
function orderWeakestFirst(blocks: readonly Block[]): readonly Block[] {
  return blocks.slice().sort((a, b) => {
    const pa = typePriority(a.type);
    const pb = typePriority(b.type);
    return pa !== pb ? pa - pb : a.id.localeCompare(b.id);
  });
}

function typePriority(type: string | undefined): number {
  switch (type) {
    case "example":
      return 0;
    case "note":
      return 1;
    case "trigger":
      return 3;
    case "policy":
      return 4;
    default:
      return 2; // body / unknown
  }
}

/** Strip a leading YAML frontmatter block (`---`…`---`) from doc text. */
function stripFrontmatter(text: string): string {
  const t = text.startsWith("﻿") ? text.slice(1) : text;
  if (!t.startsWith("---")) return t;
  const rest = t.slice(3);
  // Match the CLOSING delimiter on its OWN line. `\s*` would over-span: `\s`
  // matches line terminators, so greedy `\s*$` could swallow blank lines that
  // FOLLOW the delimiter, eating the spacing between frontmatter and the first
  // body block. `[^\S\r\n]*` restricts trailing whitespace to the SAME line
  // (spaces/tabs only, never `\n`/`\r`), so the match — and the slice point —
  // stays single-line.
  const m = /^(---|\.\.\.)[^\S\r\n]*$/m.exec(rest);
  if (!m) return t;
  return rest.slice(m.index + m[0].length);
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Derive a coarse block-TYPE label from a heading title (order-only, never score). */
function classifyHeading(title: string): string | undefined {
  const t = title.toLowerCase();
  if (/\bexample/.test(t)) return "example";
  if (/\bnote|caveat|warning/.test(t)) return "note";
  if (/\btrigger|when to use|invocation/.test(t)) return "trigger";
  if (/\bpolicy|rule|must|constraint/.test(t)) return "policy";
  return undefined;
}

/**
 * Slugify a heading title into a stable block id; fall back to the index.
 *
 * The leading/trailing `-` trim is done with `trimDashes` (a linear scan), NOT a
 * `/^-+|-+$/g` regex — the regex form trips CodeQL `js/polynomial-redos` because
 * the `-` runs come from the preceding collapse and the input is unbounded text.
 */
function slugifyHeading(title: string, index: number): string {
  const collapsed = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const slug = trimDashes(collapsed);
  return slug.length > 0 ? slug : `block-${index}`;
}

/**
 * Parse a single line as an ATX markdown heading (`#`..`######` then required
 * whitespace then a title). Returns `{ depth, title }` or `null` for non-heading
 * lines.
 *
 * Uses a linear character scan — NOT a `/^(#{1,6})\s+(.*)$/` regex — to avoid the
 * `\s+(.*)` polynomial-backtracking pattern CodeQL flags. Each character is
 * visited at most once: count `#` (1..6), require at least one following space or
 * tab, the rest (trimmed) is the title.
 */
function parseHeadingLine(line: string): { depth: number; title: string } | null {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 35 /* '#' */) i++;
  const depth = i;
  if (depth < 1 || depth > 6) return null;
  // Require at least one space or tab after the hashes (ATX rule).
  const c = line.charCodeAt(i);
  if (c !== 32 /* ' ' */ && c !== 9 /* '\t' */) return null;
  // Skip the run of leading whitespace before the title text (linear, bounded).
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return { depth, title: line.slice(i).trim() };
}

/** Strip leading and trailing `-` from a string in linear time (no regex). */
function trimDashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 45 /* '-' */) start++;
  while (end > start && s.charCodeAt(end - 1) === 45 /* '-' */) end--;
  return s.slice(start, end);
}

/**
 * Is `line` a markdown code-fence delimiter (a run of ≥3 backticks or ≥3 tildes,
 * optionally indented up to 3 spaces, optionally followed by an info string)?
 *
 * Used to toggle in-fence state so `#`-prefixed lines inside fenced code blocks
 * are not mistaken for headings. Linear character scan — no regex, no ReDoS.
 *
 * Per CommonMark, an info string may follow an opening backtick fence but must
 * NOT itself contain a backtick. We don't enforce that subtlety for closing
 * fences; for the slicer's purpose, treating any line whose first non-space run
 * is ≥3 of one fence char as a fence toggle is the safe, conservative choice
 * (it keeps `#` lines inside code out of the heading set).
 */
function isFenceLine(line: string): boolean {
  let i = 0;
  // CommonMark allows up to 3 leading spaces of indentation before a fence.
  let indent = 0;
  while (i < line.length && line.charCodeAt(i) === 32 /* ' ' */ && indent < 3) {
    i++;
    indent++;
  }
  const fenceChar = line.charCodeAt(i);
  if (fenceChar !== 96 /* '`' */ && fenceChar !== 126 /* '~' */) return false;
  let run = 0;
  while (i < line.length && line.charCodeAt(i) === fenceChar) {
    i++;
    run++;
  }
  return run >= 3;
}

/**
 * Return `base` if unseen, else the lowest `base-N` (N starting at 2) not yet in
 * `seen`. Mutates `seen` to record the returned id. Guarantees every block id is
 * unique within a single sliced doc, so anchors used for LOBO ablation never
 * collide. Linear in the number of prior collisions for a given base.
 */
function uniqueId(base: string, seen: Set<string>): string {
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  let n = 2;
  let candidate = `${base}-${n}`;
  while (seen.has(candidate)) {
    n++;
    candidate = `${base}-${n}`;
  }
  seen.add(candidate);
  return candidate;
}
