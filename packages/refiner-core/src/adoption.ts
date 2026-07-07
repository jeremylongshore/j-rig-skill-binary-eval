/**
 * adoption.ts — DETERMINISTIC time-decay adoption signal (epic intent-eval-lab#206,
 * bead bd_000-projects-ig4h.4; build-ready spec Item 4; ISEDC DR-103 D4 + D5).
 *
 * # What this is
 *
 * A skill's adoption signal answers ONE question across N tenants and M CI runs:
 * **"is this skill still earning its keep versus the bare model?"** That is an
 * ESTIMATION + a monotone DECISION, not online action-selection. The mechanism is
 * a deterministic, time-decayed adoption RATE compared against explicit thresholds.
 *
 * The Thompson-sampling bandit is REJECTED here, unconditionally, for this surface
 * (DR-103 D5): a bandit is non-deterministic by construction (PRNG draws from
 * posteriors), so the same evidence produces different verdicts on replay — which
 * breaks the Evidence-Bundle / `gate-result/v1` audit-reproducibility contract and
 * `accept()`'s replayability. A bandit's exploration term would also, by
 * construction, occasionally route a fail-closed CI gate to the INFERIOR skill
 * version to reduce posterior variance — indefensible in a fail-closed gate. A
 * contextual bandit IS legitimate for Refiner STRATEGY-selection (which
 * RefinerStrategy to try next under a token budget), but that lives inside
 * `@intentsolutions/refiner`, NEVER on this signable surface (DR-103 D5 B5.5).
 *
 * # The 2×2 — baseline-value-flag × decayed adoption (AND-combined, never averaged)
 *
 * Adoption is joined with the existing "baseline-value-flag" (does the bare model
 * match the skill?) into a 2×2. The two axes are AND-combined and NEVER averaged
 * into one scalar (C3, DR-103 C3 B6.1):
 *
 *   bare model matches? | users keep it? | verdict
 *   ------------------- | -------------- | -----------------------------------------
 *   skill adds value    | high adoption  | keep
 *   skill adds value    | low adoption   | watch              (discoverability problem)
 *   bare model matches  | high adoption  | deprecate_review   (model caught up but used)
 *   bare model matches  | low adoption   | obsolete_review    (both axes agree)
 *
 * Adoption is **advisory and only ever DEPRECATES, never PROMOTES** (DR-103 D4 B4.3):
 * the deterministic `accept()` / `decideRollout()` gates stay the shipping
 * authority. This module produces an `AdoptionVerdict`; wiring it into the launch
 * report is via an ADDITIVE opt-in `LaunchReport.adoptionVerdict?` field — the
 * `RolloutDecision` union is NOT mutated (DR-103 D4 NO-GO on the enum change).
 *
 * # Hard rules honored (DR-103 binding constraints)
 *
 *   - **Determinism (D5 B5.1):** PURE module — no I/O, no `Date.now()`. The caller
 *     INJECTS `now` (an rfc3339 string), mirroring `kernel-version.ts` /
 *     `eval-set.ts isRefreshDue`. The host launch-report function is also
 *     `now`-injected (see governance/scoring.ts) so the artifact this signal lands
 *     in is replayable. Rejecting the bandit for non-determinism while the host
 *     reads the wall clock would be incoherent.
 *   - **Thresholds calibrated/provisional, never bare literals (D5 B5.2):** the
 *     defaults are EXPLICITLY PROVISIONAL ({@link PROVISIONAL_ADOPTION_THRESHOLDS},
 *     `provisional: true`), per-ecosystem-overridable, and carry a documented
 *     calibration procedure. A verdict computed off provisional thresholds is
 *     marked `thresholdsProvisional: true` so a downstream consumer knows the
 *     numbers are not yet back-tested.
 *   - **Anti-gaming / source segregation (D5 B5.3):** only `source: "ci"`
 *     (gate-anchored, trustworthy) events count toward the deprecate axis;
 *     `source: "plugin"` (unverified) events are weighted at/near zero. Beyond
 *     source, a metered `UsageEvent` whose `source_verified !== true` is dropped
 *     entirely (the kernel anti-gaming invariant is re-checked at ingestion).
 *   - **Per-tenant first, bounded aggregate (D5 B5.3 / D2 B2.2):** per-tenant
 *     decayed rates are computed FIRST; a tenant below its own `minVolume` is
 *     EXCLUDED, never averaged in as noise. An ABSENT `tenant_id` is a first-class
 *     single-tenant/global bucket, never pooled into a cross-tenant aggregate.
 *   - **C3 — no rolled score (C3 B6.1):** the report is a per-dimension structure:
 *     a baseline-value axis, an adoption axis, and a joined verdict. There is NO
 *     single "usefulness %". {@link NO_ROLLED_ADOPTION_SCORE} documents this; a
 *     consuming-surface test asserts the absence.
 *   - **Explainable (D5 B5.4):** the verdict carries decayed evidence weight, the
 *     per-tenant breakdown, and which threshold was cleared, so a maintainer whose
 *     skill drew `deprecate_review`/`obsolete_review` can see exactly why.
 *
 * # Time decay
 *
 * Each event's weight decays exponentially with age: `weight = 0.5 ** (ageDays /
 * halfLifeDays)`. The decayed adoption rate is `Σ(weight · keptSignal) / Σ(weight)`
 * — a recency-weighted mean in closed form (skills rot as base models improve, so
 * recent usage counts more). This is the deliberate analogue of the supersession /
 * decay precedent in `kernel-version.ts`.
 *
 * Sources:
 *   - intent-eval-lab/000-docs/102-AT-SPEC-skill-scoring-gap-fill-build-ready-design-2026-06-25.md Item 4
 *   - intent-eval-lab/000-docs/103-AT-DECR-isedc-skill-scoring-kernel-contracts-2026-06-25.md D4 + D5
 *   - @intentsolutions/core: UsageEvent + HumanReview (kernel 0.9.0, DR-103 D1)
 *   - kernel-version.ts: the now-injection + inline-no-dep determinism precedent
 *   - governance/baseline.ts: compareBaseline / isObsoleteCandidate (the baseline-value-flag)
 */

import type { HumanReview, UsageEvent } from "@intentsolutions/core";

// ── No-reduce marker (C3, DR-103 C3 B6.1) ────────────────────────────────────

/**
 * Documented structural marker: this module NEVER reduces the baseline-value axis
 * and the adoption axis into a single skill-level scalar (no "usefulness %", no
 * headline number). The C3 defense is the ABSENCE of a rolled-score field on
 * {@link AdoptionVerdict} — the two axes are AND-combined into a discrete verdict,
 * never averaged. A consuming-surface test asserts this marker stays true.
 */
export const NO_ROLLED_ADOPTION_SCORE = true as const;

// ── Event source segregation (DR-103 D5 B5.3) ────────────────────────────────

/**
 * Provenance of a usage observation, for the anti-gaming source split.
 *
 * - `ci`     — emitted from a gate-anchored CI run (trustworthy; the deterministic
 *              gate stands behind it). Full weight on the deprecate axis.
 * - `plugin` — emitted from an unverified plugin/runtime load (NOT gate-anchored).
 *              Weighted at/near zero on the deprecate axis — an unverified load
 *              must not be able to inflate "still used" and dodge a deprecation.
 */
export type AdoptionEventSource = "ci" | "plugin";

// ── Adoption observation (the decayable unit) ────────────────────────────────

/**
 * A single decayable adoption observation, derived from a verified kernel
 * `UsageEvent` (gated source + `source_verified === true`) optionally joined with
 * the HumanReview signal for the same session. This is the value the decay kernel
 * weights — NOT the raw kernel row (which carries fields the decay does not use).
 *
 * `kept` is the binary "did the user keep / re-use the skill" signal this
 * observation contributes (1 = kept/used, 0 = abandoned). Most metered usage rows
 * are `kept: true` by construction (the user invoked the skill); an explicit
 * thumbs-down HumanReview pinned to the same session flips it to `kept: false`.
 */
export interface AdoptionObservation {
  /** rfc3339 timestamp of the metered action (from `UsageEvent.recorded_at`). */
  readonly at: string;
  /** Provenance for the anti-gaming source split. */
  readonly source: AdoptionEventSource;
  /**
   * Tenant bucket. `undefined` = the single-tenant/global bucket (a first-class
   * state, NEVER pooled into a cross-tenant aggregate — DR-103 D2 B2.2).
   */
  readonly tenantId?: string;
  /** 1 = the skill was kept/used; 0 = abandoned (e.g. an explicit thumbs-down). */
  readonly kept: 0 | 1;
}

// ── Thresholds (provisional, calibrated, overridable — DR-103 D5 B5.2) ────────

/**
 * Adoption-decision thresholds. Per DR-103 D5 B5.2 these are NEVER bare literals:
 * the shipped defaults are {@link PROVISIONAL_ADOPTION_THRESHOLDS} (`provisional:
 * true`), per-ecosystem-overridable, with a documented calibration procedure (see
 * the README + the `provisional` flag that propagates onto every verdict).
 */
export interface AdoptionThresholds {
  /**
   * Half-life of the exponential decay, in days. An observation `halfLifeDays`
   * old contributes half the weight of a same-signal observation today. Skills rot
   * fastest right after a frontier model bump, so the default is deliberately
   * short (recency-biased). PROVISIONAL — calibrate per ecosystem.
   */
  readonly halfLifeDays: number;
  /**
   * Minimum DECAYED evidence weight a tenant bucket must carry to be counted at
   * all. A bucket below this is EXCLUDED from the cross-tenant aggregate (never
   * averaged in as noise — DR-103 D5 B5.3). A low-evidence skill is HELD, not
   * deprecated. PROVISIONAL.
   */
  readonly minVolume: number;
  /**
   * Decayed adoption rate (0..1) at or above which adoption is "high". A clearly
   * high rate means users keep the skill. PROVISIONAL.
   */
  readonly highAdoptionRate: number;
  /**
   * Decayed adoption rate (0..1) at or below which adoption is "low". A clearly
   * low rate means users dropped the skill. Between low and high is the
   * INCONCLUSIVE band (no deprecate verdict fires). PROVISIONAL.
   */
  readonly lowAdoptionRate: number;
  /**
   * Weight multiplier applied to `source: "plugin"` (unverified) observations on
   * the deprecate axis. Near zero by design — an unverified load must not be able
   * to inflate "still used". `ci` observations always carry weight 1.0.
   * PROVISIONAL.
   */
  readonly pluginSourceWeight: number;
  /**
   * `true` ⇒ these thresholds are NOT yet back-tested against real event
   * distributions and MUST NOT be treated as load-bearing on a production verdict
   * (the flag propagates onto every verdict as `thresholdsProvisional`). Set
   * `false` only after the documented calibration + back-test procedure.
   */
  readonly provisional: boolean;
}

/**
 * The SHIPPED defaults — EXPLICITLY PROVISIONAL (DR-103 D5 B5.2 + CFO bound
 * condition). These are conservative starting values, NOT tuned constants. They
 * MUST be calibrated against a real soak window of event data before any verdict
 * computed from them is treated as load-bearing on a production rollout.
 *
 * Calibration procedure (documented per B5.2):
 *   1. Accumulate ≥1 soak window of real `usage_events` + `human_reviews` per
 *      ecosystem (CI + plugin), partitioned by tenant.
 *   2. Plot the decayed-rate distribution; set `highAdoptionRate` /
 *      `lowAdoptionRate` at the empirical knees, not at round numbers.
 *   3. Set `minVolume` so a tenant whose evidence weight is below it is genuinely
 *      under-powered (mirror the `accept.ts` significance posture: low evidence ⇒
 *      hold, never deprecate).
 *   4. Tie `halfLifeDays` to the observed model-release cadence (skills rot fastest
 *      right after a frontier bump).
 *   5. Back-test the verdicts against known-good / known-obsolete skills; only then
 *      flip `provisional: false`.
 */
export const PROVISIONAL_ADOPTION_THRESHOLDS: AdoptionThresholds = {
  halfLifeDays: 30,
  minVolume: 3,
  highAdoptionRate: 0.6,
  lowAdoptionRate: 0.2,
  pluginSourceWeight: 0.1,
  provisional: true,
};

// ── Baseline-value axis (the existing "does the bare model match?" flag) ──────

/**
 * The baseline-value axis of the 2×2 — the EXISTING j-rig signal, re-expressed.
 *
 * - `skill-adds-value` — the skill outperforms the bare model (NOT an obsolete
 *   candidate). `isObsoleteCandidate(comparisons) === false`.
 * - `bare-model-matches` — the bare model matches the skill on most criteria (an
 *   obsolete candidate). `isObsoleteCandidate(comparisons) === true`.
 *
 * The caller derives this from `compareBaseline` + `isObsoleteCandidate` in
 * `@j-rig/core` governance (the baseline-value-flag); this module just consumes
 * the boolean so it stays pure (no judgment dependency).
 */
export type BaselineValueAxis = "skill-adds-value" | "bare-model-matches";

// ── Adoption axis (the decayed-rate classification) ──────────────────────────

/**
 * The adoption axis of the 2×2 — the decayed-rate classification.
 *
 * - `high`         — decayed rate ≥ `highAdoptionRate` AND adequate evidence weight.
 * - `low`          — decayed rate ≤ `lowAdoptionRate` AND adequate evidence weight.
 * - `inconclusive` — rate between low and high (no clear signal).
 * - `insufficient` — total qualifying evidence weight below `minVolume` (HOLD;
 *                    a low-evidence skill is never deprecated — DR-103 D5 B5.3).
 */
export type AdoptionAxis = "high" | "low" | "inconclusive" | "insufficient";

// ── Joined verdict ───────────────────────────────────────────────────────────

/**
 * The joined 2×2 verdict. Advisory-and-deprecate-only (DR-103 D4 B4.3); NEVER
 * promotes a skill and never overrides the deterministic `accept()` gate.
 *
 * - `keep`            — skill adds value AND high adoption.
 * - `watch`           — skill adds value BUT low adoption (a discoverability
 *                       problem, not an obsolescence one). Advisory only.
 * - `deprecate_review`— bare model matches BUT still highly adopted (the model
 *                       caught up; a human should decide). Advisory only.
 * - `obsolete_review` — bare model matches AND low adoption (both axes agree).
 *                       Advisory only — surfaces for human review, never auto-ships.
 * - `hold`            — evidence is inconclusive or insufficient; NO deprecate
 *                       fires (a low-evidence skill is held, not deprecated).
 */
export type AdoptionVerdictKind =
  "keep" | "watch" | "deprecate_review" | "obsolete_review" | "hold";

/** Per-tenant decayed breakdown (DR-103 D5 B5.4 — the verdict must be explainable). */
export interface TenantAdoption {
  /** Tenant bucket label; `null` = the single-tenant/global bucket. */
  readonly tenantId: string | null;
  /** Decayed adoption rate for this tenant (0..1), or null when below `minVolume`. */
  readonly decayedRate: number | null;
  /** Total decayed evidence weight backing this tenant's rate. */
  readonly evidenceWeight: number;
  /** `true` when this tenant cleared its own `minVolume` and was counted. */
  readonly counted: boolean;
}

/**
 * The COMPUTED adoption verdict — a per-DIMENSION structure (C3), carrying the two
 * axes, the joined verdict, the per-tenant breakdown, and full provenance so the
 * verdict is explainable (DR-103 D5 B5.4). There is deliberately NO rolled
 * "usefulness %" field ({@link NO_ROLLED_ADOPTION_SCORE}).
 */
export interface AdoptionVerdict {
  /** The baseline-value axis (does the bare model match?). */
  readonly baselineValue: BaselineValueAxis;
  /** The decayed-adoption axis. */
  readonly adoption: AdoptionAxis;
  /** The joined 2×2 verdict (advisory-and-deprecate-only). */
  readonly verdict: AdoptionVerdictKind;
  /**
   * Cross-tenant decayed adoption rate (0..1) over the COUNTED tenants only
   * (bounded per-tenant weight; under-volume tenants excluded), or null when no
   * tenant cleared `minVolume`. NOT a rolled score — it is the single adoption
   * dimension's rate, the input to the adoption axis, not a blend of axes.
   */
  readonly decayedRate: number | null;
  /** Total decayed evidence weight across COUNTED tenants. */
  readonly evidenceWeight: number;
  /** Per-tenant breakdown (computed FIRST; the cross-tenant rate aggregates these). */
  readonly perTenant: readonly TenantAdoption[];
  /** The injected `now` the decay was computed against (replayability anchor). */
  readonly evaluatedAt: string;
  /**
   * `true` ⇒ the thresholds used were provisional / not back-tested. A consumer
   * MUST NOT treat a verdict with this flag as load-bearing on a production rollout
   * (DR-103 D5 B5.2 + CFO bound condition).
   */
  readonly thresholdsProvisional: boolean;
}

// ── Options ──────────────────────────────────────────────────────────────────

/** Options for {@link computeAdoptionVerdict}. */
export interface ComputeAdoptionOptions {
  /**
   * The baseline-value axis, derived by the caller from `compareBaseline` +
   * `isObsoleteCandidate` (the existing baseline-value-flag). `bare-model-matches`
   * ⇒ obsolete candidate.
   */
  readonly baselineValue: BaselineValueAxis;
  /** The decayable adoption observations (verified usage joined with reviews). */
  readonly observations: readonly AdoptionObservation[];
  /**
   * Wall-clock "now" as an rfc3339 string. INJECTED for determinism (DR-103 D5
   * B5.1) — this module NEVER reads the clock. Required (no default): a default
   * would silently re-introduce wall-clock non-determinism.
   */
  readonly now: string;
  /**
   * Thresholds. Defaults to {@link PROVISIONAL_ADOPTION_THRESHOLDS} (provisional,
   * overridable). Pass calibrated, back-tested thresholds (`provisional: false`)
   * to make a verdict load-bearing.
   */
  readonly thresholds?: AdoptionThresholds;
}

// ── Core: computeAdoptionVerdict ─────────────────────────────────────────────

/**
 * Compute the deterministic time-decay adoption verdict.
 *
 * Algorithm:
 *   1. Bucket observations by tenant (`undefined` = the global bucket; never pooled
 *      cross-tenant). Per tenant, compute the decayed adoption rate:
 *      `Σ(weight · kept) / Σ(weight)` where
 *      `weight = sourceWeight · 0.5 ** (ageDays / halfLifeDays)` and `ageDays`
 *      is `(now − at)` in days (a future-dated event is clamped to age 0).
 *   2. A tenant whose decayed evidence weight is below `minVolume` is EXCLUDED
 *      from the cross-tenant aggregate (held, not averaged in).
 *   3. The cross-tenant rate is the evidence-weighted mean over COUNTED tenants
 *      only (bounded per-tenant contribution).
 *   4. Classify the adoption axis from the cross-tenant rate (high/low/
 *      inconclusive) or `insufficient` when no tenant was counted.
 *   5. Join with the baseline-value axis into the advisory 2×2 verdict.
 *
 * PURE: no I/O, no `Date.now()`. Deterministic for a given (observations, now,
 * thresholds) triple.
 */
export function computeAdoptionVerdict(opts: ComputeAdoptionOptions): AdoptionVerdict {
  const thresholds = opts.thresholds ?? PROVISIONAL_ADOPTION_THRESHOLDS;
  const nowMs = Date.parse(opts.now);

  // ── (1) bucket by tenant, decay-weight each observation ──────────────────────
  // Map key: the tenant id, or a reserved sentinel for the global bucket. The
  // sentinel can never collide with a real UUIDv7 tenant id.
  const GLOBAL = " global";
  const buckets = new Map<string, { weightSum: number; keptWeightSum: number }>();

  for (const obs of opts.observations) {
    const sourceWeight = obs.source === "ci" ? 1 : thresholds.pluginSourceWeight;
    if (sourceWeight <= 0) continue; // fully-discounted source contributes nothing

    const ageDays = Math.max(0, (nowMs - Date.parse(obs.at)) / MS_PER_DAY);
    const decay = Math.pow(0.5, ageDays / thresholds.halfLifeDays);
    const weight = sourceWeight * decay;
    if (weight <= 0) continue;

    const key = obs.tenantId ?? GLOBAL;
    const bucket = buckets.get(key) ?? { weightSum: 0, keptWeightSum: 0 };
    bucket.weightSum += weight;
    bucket.keptWeightSum += weight * obs.kept;
    buckets.set(key, bucket);
  }

  // ── (2)+(3) per-tenant rates; exclude under-volume; aggregate counted only ───
  const perTenant: TenantAdoption[] = [];
  let countedWeight = 0;
  let countedKeptWeight = 0;

  // Stable order: global bucket last, real tenants sorted by id (determinism).
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === GLOBAL) return 1;
    if (b === GLOBAL) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  for (const key of keys) {
    const bucket = buckets.get(key)!;
    const counted = bucket.weightSum >= thresholds.minVolume;
    const decayedRate = counted ? bucket.keptWeightSum / bucket.weightSum : null;
    perTenant.push({
      tenantId: key === GLOBAL ? null : key,
      decayedRate,
      evidenceWeight: bucket.weightSum,
      counted,
    });
    if (counted) {
      countedWeight += bucket.weightSum;
      countedKeptWeight += bucket.keptWeightSum;
    }
  }

  const decayedRate = countedWeight > 0 ? countedKeptWeight / countedWeight : null;

  // ── (4) adoption axis ────────────────────────────────────────────────────────
  const adoption = classifyAdoptionAxis(decayedRate, thresholds);

  // ── (5) join into the advisory 2×2 verdict ───────────────────────────────────
  const verdict = joinVerdict(opts.baselineValue, adoption);

  return {
    baselineValue: opts.baselineValue,
    adoption,
    verdict,
    decayedRate,
    evidenceWeight: countedWeight,
    perTenant,
    evaluatedAt: opts.now,
    thresholdsProvisional: thresholds.provisional,
  };
}

// ── Internals ────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Classify the adoption axis from the cross-tenant decayed rate. */
function classifyAdoptionAxis(
  decayedRate: number | null,
  thresholds: AdoptionThresholds,
): AdoptionAxis {
  if (decayedRate === null) return "insufficient";
  if (decayedRate >= thresholds.highAdoptionRate) return "high";
  if (decayedRate <= thresholds.lowAdoptionRate) return "low";
  return "inconclusive";
}

/**
 * Join the baseline-value axis × adoption axis into the advisory 2×2 verdict.
 * AND-combined, never averaged (C3). Advisory-and-deprecate-only: when adoption is
 * `inconclusive`/`insufficient`, the verdict is `hold` (no deprecate fires —
 * DR-103 D5 B5.3 holds a low-evidence skill rather than deprecating it).
 */
function joinVerdict(baseline: BaselineValueAxis, adoption: AdoptionAxis): AdoptionVerdictKind {
  // Inconclusive / insufficient evidence ⇒ HOLD on BOTH baseline cases. A skill is
  // never deprecated on weak evidence, and never "kept" on weak evidence either.
  if (adoption === "inconclusive" || adoption === "insufficient") {
    return "hold";
  }
  if (baseline === "skill-adds-value") {
    return adoption === "high" ? "keep" : "watch";
  }
  // bare-model-matches
  return adoption === "high" ? "deprecate_review" : "obsolete_review";
}

// ── Adapter: kernel rows → decayable observations (DR-103 anti-gaming re-check) ──

/** Options for {@link toAdoptionObservations}. */
export interface ToObservationsOptions {
  /**
   * The verified kernel usage rows. Each MUST satisfy the kernel anti-gaming
   * invariant (a metered, non-`api_call` row with `source_verified === true` and a
   * non-null gated source). Rows that fail are DROPPED here as a belt-and-suspenders
   * re-check at ingestion (the kernel validator already enforces this on parse).
   */
  readonly usageEvents: readonly UsageEvent[];
  /**
   * HumanReview rows pinned to the same sessions. A row with `thumbs === false`
   * flips its session's observation to `kept: 0` (abandoned). Reviews authored by
   * a service account are already excluded by the kernel (`reviewer_is_service_account`
   * is the literal `false`), so they never appear here.
   */
  readonly humanReviews?: readonly HumanReview[];
  /**
   * Maps a `UsageEvent` to its adoption source. The kernel `UsageEvent` does not
   * carry a CI-vs-plugin provenance field, so the INTAKE layer (the CLI verbs)
   * supplies it. Defaults every row to `"plugin"` (the conservative, low-trust
   * assumption) when no mapping is given — an unverified default never inflates
   * the deprecate axis.
   */
  readonly sourceOf?: (event: UsageEvent) => AdoptionEventSource;
}

/**
 * Adapt verified kernel `UsageEvent` + `HumanReview` rows into decayable
 * {@link AdoptionObservation}s, re-applying the anti-gaming invariant at ingestion
 * (DR-103 D5 B5.3): a metered row whose `source_verified !== true` is DROPPED.
 *
 * `api_call`-metered rows are dropped too — an `api_call` is the leaf provider
 * action with no gated parent session, so it is not an adoption signal for a
 * SKILL (it has no `skill_invocation` / `eval_run` provenance to anchor "the user
 * kept the skill"). Adoption is measured off product-meter usage of the skill,
 * not raw provider calls.
 *
 * A `HumanReview` with `thumbs === false` whose `session_trace_id` matches a usage
 * row's `source_entity_id` flips that observation to `kept: 0`. (Open-ended
 * `score_text` is NON-COMPARABLE free text per DR-103 C3 B6.3 and is NEVER parsed
 * into a kept/abandoned signal.)
 */
export function toAdoptionObservations(
  opts: ToObservationsOptions,
): readonly AdoptionObservation[] {
  // Sessions a human explicitly thumbed-down (pinned to a verified session).
  const thumbedDownSessions = new Set<string>();
  for (const review of opts.humanReviews ?? []) {
    if (review.thumbs === false && review.session_trace_id !== null) {
      thumbedDownSessions.add(review.session_trace_id as string);
    }
  }

  const sourceOf = opts.sourceOf ?? (() => "plugin" as AdoptionEventSource);
  const observations: AdoptionObservation[] = [];

  for (const event of opts.usageEvents) {
    // Anti-gaming re-check: only verified, metered (non-api_call) rows are
    // adoption signal. The kernel enforces this on parse; we re-assert at ingest.
    if (event.meter === "api_call") continue;
    if (event.source_verified !== true) continue;
    if (event.source_entity_id === null) continue;

    const kept: 0 | 1 = thumbedDownSessions.has(event.source_entity_id as string) ? 0 : 1;
    const observation: AdoptionObservation = {
      at: event.recorded_at as string,
      source: sourceOf(event),
      kept,
      ...(event.tenant_id !== undefined ? { tenantId: event.tenant_id as string } : {}),
    };
    observations.push(observation);
  }

  return observations;
}
