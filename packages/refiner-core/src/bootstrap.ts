/**
 * bootstrap — synthesize a held-out EvalSet from a SKILL.md (AC-6, deterministic).
 *
 * Eval-set bootstrap is non-optional (Karpathy AC-6): every skill the Refiner
 * touches needs a held-out set. Plan 027 § 4 names three sources — synthetic
 * (from SKILL.md), harvested (j-rig rollouts), golden (human-nominated). This
 * foundation ships the DETERMINISTIC synthetic source: given identical SKILL.md
 * text + options, it always produces the identical EvalSet (same items, same
 * hash). Harvested/golden ingestion is an I/O adapter (wave 2+).
 *
 * DR-028 P0-RATIFY-6: the produced EvalSet carries `evalSetVersion` (semver) +
 * `lineageParent` (hash of a prior set, or null) + `refreshDueAt` (rfc3339, 90d
 * default; null in `--quick` mode per the VP DevRel binding).
 */

import type { SkillDoc, EvalSet, EvalItem } from "./types.js";
import { hashValue } from "./hash.js";

const DEFAULT_REFRESH_DAYS = 90;

export interface BootstrapOptions {
  /**
   * Semver of the eval set being produced. Defaults to "1.0.0" for a root set;
   * bump when re-bootstrapping a lineage.
   */
  readonly evalSetVersion?: string;
  /** Hash of the prior eval set in the lineage, or null for the root set. */
  readonly lineageParent?: string | null;
  /**
   * Quick mode (VP DevRel binding): skip refresh-due-at + comprehensive coverage
   * for casual contributors. Still emits version + lineage.
   */
  readonly quick?: boolean;
  /**
   * Wall-clock "now" as rfc3339. Injected for determinism (the only non-pure
   * input is the clock; passing it explicitly keeps bootstrap a pure function).
   * Used to compute `refreshDueAt`. Ignored in quick mode.
   */
  readonly now?: string;
}

/**
 * Extract candidate behavioral prompts from a SKILL.md. The synthetic strategy
 * is intentionally simple + deterministic: every non-empty, non-frontmatter,
 * non-heading line that reads like an imperative or a bullet becomes a probe.
 * This is the unsexy 80% (plan build-order step 3) — a real coverage analysis
 * lands later; this gives a held-out set you can score against today.
 */
function extractProbes(text: string): string[] {
  const body = stripFrontmatter(text);
  const probes: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue; // headings are structure, not behavior
    if (line.startsWith("```")) continue; // fence markers
    // Bulleted procedural lines + sentences are behavioral probes.
    const cleaned = line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");
    if (cleaned.length < 12) continue; // too short to be a meaningful probe
    probes.push(cleaned);
  }
  return probes;
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4);
}

function rfc3339Plus(now: string, days: number): string {
  const ms = Date.parse(now);
  if (Number.isNaN(ms)) {
    throw new RangeError(`bootstrap: 'now' is not a valid rfc3339 timestamp: ${now}`);
  }
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Synthesize a deterministic synthetic EvalSet from a skill doc.
 *
 * Pure: same `doc.text` + same `opts` → same EvalSet (including hash). The clock
 * enters only via `opts.now` (explicit), so determinism is preserved.
 */
export function bootstrap(doc: SkillDoc, opts: BootstrapOptions = {}): EvalSet {
  const evalSetVersion = opts.evalSetVersion ?? "1.0.0";
  const lineageParent = opts.lineageParent ?? null;
  const quick = opts.quick ?? false;

  const probes = extractProbes(doc.text);
  const items: EvalItem[] = probes.map((prompt, i) => ({
    id: `${doc.skillId}-syn-${String(i + 1).padStart(3, "0")}`,
    prompt,
  }));

  let refreshDueAt: string | null = null;
  if (!quick) {
    const now = opts.now ?? new Date(0).toISOString();
    refreshDueAt = rfc3339Plus(now, DEFAULT_REFRESH_DAYS);
  }

  // Hash over the content-bearing fields (NOT the hash itself). refreshDueAt is
  // included so two sets bootstrapped at different times remain distinguishable.
  const hash = hashValue({
    skillId: doc.skillId,
    source: "synthetic",
    items,
    evalSetVersion,
    lineageParent,
    refreshDueAt,
  });

  return {
    hash,
    skillId: doc.skillId,
    source: "synthetic",
    items,
    evalSetVersion,
    lineageParent,
    refreshDueAt,
  };
}
