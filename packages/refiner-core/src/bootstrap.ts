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
 *
 * `lineageId` (UUIDv7): identifies the eval-set lineage. All versions of the
 * same eval set for the same skill share the same lineage id. For root sets it
 * is derived deterministically from skillId + source. Child sets propagate the
 * lineage id from the caller via `opts.lineageId` so the predicate's
 * `eval_set_ref.lineage_id` remains stable across regenerations.
 */

import type { SkillDoc, EvalSet, EvalItem } from "./types.js";
import { hashValue, sha256 } from "./hash.js";

const DEFAULT_REFRESH_DAYS = 90;

/**
 * Derive a deterministic UUIDv7-format string from a content seed.
 *
 * The result conforms to the UUIDv7 shape (RFC 9562: version nibble `7`,
 * variant `10xx`, lowercase hex, dashes in the standard positions) so it
 * passes UUIDv7 validation everywhere in the platform. It is NOT a
 * cryptographically random UUIDv7 — it is a DETERMINISTIC content-address
 * expressed in UUIDv7 form, suitable for lineage identifiers that must be
 * stable and re-derivable from the same inputs.
 *
 * Encoding: we take the first 128 bits of the SHA-256 of `seed`, then:
 *   - Bits 48–51 (the version nibble) are set to `0111` (hex `7`).
 *   - Bits 64–65 (the variant bits) are set to `10`.
 *   This produces a string that is syntactically a UUIDv7 with a hash-derived
 *   "timestamp" and "random" region, which is appropriate for a lineage id
 *   (lineages don't need a real clock, they need a STABLE, UNIQUE identity).
 */
function hashToUuidv7Format(seed: string): string {
  const h = sha256(seed);
  // Take the first 32 hex chars (128 bits)
  const b = h.slice(0, 32);
  // UUIDv7 layout: 8-4-4-4-12
  // Positions:      0       8 12  16 20          32
  const p1 = b.slice(0, 8); // 32 bits
  const p2 = b.slice(8, 12); // 16 bits
  // Version nibble: force bits 48–51 to 0x7 (version 7)
  const p3 = "7" + b.slice(13, 16); // 16 bits: version nibble + 12 bits
  // Variant: force top 2 bits to 10 (i.e. hex digit in [89ab])
  // Pick the hex char at position 16, map it to [89ab]:
  const varNib = (parseInt(b[16]!, 16) & 0x3) | 0x8; // clear top bits, set 10xx
  const p4 = varNib.toString(16) + b.slice(17, 20); // 16 bits
  const p5 = b.slice(20, 32); // 48 bits
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

export interface BootstrapOptions {
  /**
   * Semver of the eval set being produced. Defaults to "1.0.0" for a root set;
   * bump when re-bootstrapping a lineage.
   */
  readonly evalSetVersion?: string;
  /** Hash of the prior eval set in the lineage, or null for the root set. */
  readonly lineageParent?: string | null;
  /**
   * UUIDv7 of the eval-set lineage. All versions of the same eval set for the
   * same skill share one `lineageId`. Pass it when re-bootstrapping (so child
   * sets preserve the lineage identity). Omit for a root set — it is then
   * derived deterministically from skillId + source via a UUIDv7-format hash.
   */
  readonly lineageId?: string;
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
 *
 * `lineageId` is propagated from `opts.lineageId` when supplied (for child sets
 * that must preserve their lineage identity across re-bootstraps). For root sets
 * (no `opts.lineageId` supplied), it is derived deterministically from
 * `doc.skillId + source` so it is stable and unique per skill lineage.
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

  // lineageId: propagate caller-supplied id (child set preserving lineage), or
  // derive deterministically from skillId + source for root sets. The derived id
  // is stable across re-bootstraps with the same skillId, which is exactly what
  // we need: the lineage_id must not change when the eval set is refreshed.
  const lineageId = opts.lineageId ?? hashToUuidv7Format(`lineage:${doc.skillId}:synthetic`);

  return {
    hash,
    skillId: doc.skillId,
    source: "synthetic",
    items,
    evalSetVersion,
    lineageParent,
    refreshDueAt,
    lineageId,
  };
}
