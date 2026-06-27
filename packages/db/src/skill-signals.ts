/**
 * skill-signals.ts — local SQLite intake for skill usage + human reviews
 * (epic intent-eval-lab#206, bead bd_000-projects-ig4h.5; build-ready spec Item 5;
 * ISEDC DR-103 D1/D2/D5).
 *
 * Two append-only fact tables back the `j-rig ingest-skill` + `j-rig review`
 * intake verbs:
 *
 *   - `skill_usage_events` — one row per metered skill usage, GATED by a CASS
 *     session-quality score (see {@link scoreCass}). A failing row is PERSISTED
 *     (`cass_passed = 0`) but EXCLUDED from every adoption rollup
 *     (`WHERE cass_passed = 1`). Persist-but-exclude beats drop-on-ingest: it
 *     makes "load-in-a-loop to inflate adoption" VISIBLE in the data instead of
 *     silently absent. There is NO `--force-count` path.
 *   - `skill_human_reviews` — one row per `j-rig review` thumb + open-ended TEXT
 *     rationale. A CURATED-SIGNAL row (`governance_class = 'curated-signal'`):
 *     explicitly NOT a signed in-toto `human-review/v1` predicate and never a
 *     trust root (doc 072 R6). The signed kernel HumanReview entity is a separate,
 *     gated surface.
 *
 * # DR-103 bindings honored
 *
 *   - **CASS anti-gaming gate (D5 B5.3 / spec Item 5):** usage counts ONLY from
 *     session-quality-gated sessions (à la meta_skill's `quality.rs` CASS gate),
 *     never raw loads. `cass_passed` is computed at intake; rollups filter on it.
 *   - **Tenant column in the FIRST `CREATE TABLE` (D2 B2.1 / spec Item 5 fix):**
 *     `database.ts` is CREATE-TABLE-IF-NOT-EXISTS only (no ALTER path), so the
 *     `tenant_id` column lands at creation. An ABSENT tenant (NULL) is a
 *     first-class single-tenant/global bucket, never pooled cross-tenant
 *     (DR-103 D2 B2.2) — the adoption rollup partitions by tenant.
 *   - **Local-SQLite only, OTel stays off (spec Item 5):** no in-toto signing, no
 *     `usage.*`/`review.*` OTel events (the OTel name set is closed/normative per
 *     doc 067). These rows are repo-local fact tables.
 *   - **C3 (B6.1):** the rollups below return per-(meter)/per-(signal) homogeneous
 *     counts — never a cross-dimension scalar. No "usefulness %" is computable here.
 *
 * The CLI verbs that WRITE these rows live in `@j-rig/cli`
 * (`commands/ingest-skill.ts`, `commands/review.ts`); this module is the pure
 * persistence + CASS-gate layer they call.
 */

import { eq } from "drizzle-orm";
import type { JRigDatabase } from "./database.js";
import { skillUsageEvents, skillHumanReviews } from "./schema.js";

// ── CASS gate (ported from meta_skill quality.rs, spec Item 5) ────────────────

/**
 * Session-quality inputs for the CASS gate. Each flag is an observable property
 * of the session that produced a usage event. The runtime / CLI caller supplies
 * them; a developer never hand-asserts a pass.
 */
export interface CassInputs {
  /** Tests ran and passed during the session. +0.25 */
  readonly testsPassed?: boolean;
  /** The session reached a clear resolution (not abandoned mid-task). +0.25 */
  readonly clearResolution?: boolean;
  /** The session produced code changes. +0.15 */
  readonly codeChanges?: boolean;
  /** The user explicitly confirmed the result was useful. +0.15 */
  readonly userConfirmed?: boolean;
  /** The session involved backtracking / undoing work. −0.10 */
  readonly backtracking?: boolean;
  /** The session was abandoned. −0.20 */
  readonly abandoned?: boolean;
}

/** The CASS pass threshold (spec Item 5): a session scoring ≥ 0.30 is gate-passing. */
export const CASS_PASS_THRESHOLD = 0.3;

/** Per-signal CASS weights (spec Item 5, ported from meta_skill quality.rs). */
export const CASS_WEIGHTS = {
  testsPassed: 0.25,
  clearResolution: 0.25,
  codeChanges: 0.15,
  userConfirmed: 0.15,
  backtracking: -0.1,
  abandoned: -0.2,
} as const;

/** Result of {@link scoreCass}. */
export interface CassResult {
  /** Raw CASS score (may be negative). */
  readonly score: number;
  /** `true` iff `score >= CASS_PASS_THRESHOLD`. Drives `cass_passed` on the row. */
  readonly passed: boolean;
}

/**
 * Compute the CASS session-quality score. Starts at 0.0; sums the weighted
 * signals; PASS iff ≥ {@link CASS_PASS_THRESHOLD}. Pure + deterministic.
 *
 * The score is recorded on every usage row (passing or failing) so a failing
 * (gamed) row is persisted-but-excluded — visible in the data, never counted.
 */
export function scoreCass(inputs: CassInputs): CassResult {
  let score = 0;
  if (inputs.testsPassed) score += CASS_WEIGHTS.testsPassed;
  if (inputs.clearResolution) score += CASS_WEIGHTS.clearResolution;
  if (inputs.codeChanges) score += CASS_WEIGHTS.codeChanges;
  if (inputs.userConfirmed) score += CASS_WEIGHTS.userConfirmed;
  if (inputs.backtracking) score += CASS_WEIGHTS.backtracking;
  if (inputs.abandoned) score += CASS_WEIGHTS.abandoned;
  return { score, passed: score >= CASS_PASS_THRESHOLD };
}

// ── Usage event intake ────────────────────────────────────────────────────────

/** The adoption-source provenance recorded on a usage row (DR-103 D5 B5.3). */
export type UsageEventSource = "ci" | "plugin";

/** Input to {@link recordSkillUsage}. */
export interface RecordSkillUsageInput {
  /** kebab-slug skill id the usage is for. */
  readonly skillId: string;
  /** Opaque session id the usage occurred in (the CASS-gated session). */
  readonly sessionId: string;
  /** Provenance: gate-anchored `ci` vs unverified `plugin` (DR-103 D5 B5.3). */
  readonly source: UsageEventSource;
  /** CASS session-quality inputs — the anti-gaming gate (spec Item 5). */
  readonly cass: CassInputs;
  /**
   * Tenant bucket. Omit for the single-tenant/global bucket (a first-class state,
   * never pooled cross-tenant — DR-103 D2 B2.2). Stored as NULL when omitted.
   */
  readonly tenantId?: string;
  /** rfc3339 timestamp the usage occurred. INJECTED for determinism. */
  readonly recordedAt: string;
}

/** A persisted usage row, including the computed CASS verdict. */
export interface SkillUsageRecord {
  readonly id: number;
  readonly skillId: string;
  readonly sessionId: string;
  readonly source: UsageEventSource;
  readonly cassScore: number;
  readonly cassPassed: boolean;
  readonly tenantId: string | null;
  readonly recordedAt: string;
}

/**
 * Record one skill-usage event, computing + persisting its CASS verdict.
 *
 * The row is ALWAYS persisted (passing or failing). A failing row carries
 * `cass_passed = 0` and is excluded from {@link countVerifiedUsage} — the
 * persist-but-exclude discipline that makes load-to-inflate visible. There is no
 * way for a caller to force a failing row to count.
 */
export function recordSkillUsage(
  { db }: JRigDatabase,
  input: RecordSkillUsageInput,
): SkillUsageRecord {
  const cass = scoreCass(input.cass);
  const row = db
    .insert(skillUsageEvents)
    .values({
      skill_id: input.skillId,
      session_id: input.sessionId,
      source: input.source,
      cass_score: cass.score,
      cass_passed: cass.passed,
      tenant_id: input.tenantId ?? null,
      recorded_at: input.recordedAt,
    })
    .returning()
    .get();
  return toUsageRecord(row);
}

// ── Human review intake ────────────────────────────────────────────────────────

/** Input to {@link recordSkillReview}. */
export interface RecordSkillReviewInput {
  /** kebab-slug skill id the review is for. */
  readonly skillId: string;
  /** Coarse thumb: `true` = up, `false` = down. */
  readonly thumbsUp: boolean;
  /** Open-ended NON-COMPARABLE free-text rationale (DR-103 C3 B6.3). Optional. */
  readonly rationale?: string;
  /** Reviewer identity (engineer email / handle). */
  readonly reviewer: string;
  /** Tenant bucket; omit for the single-tenant/global bucket. Stored NULL. */
  readonly tenantId?: string;
  /** rfc3339 timestamp the review was recorded. INJECTED for determinism. */
  readonly recordedAt: string;
}

/** A persisted curated-signal review row. */
export interface SkillReviewRecord {
  readonly id: number;
  readonly skillId: string;
  readonly thumbsUp: boolean;
  readonly rationale: string | null;
  readonly reviewer: string;
  /** Always `"curated-signal"` — NOT a signed `human-review/v1` predicate (doc 072 R6). */
  readonly governanceClass: "curated-signal";
  readonly tenantId: string | null;
  readonly recordedAt: string;
}

/**
 * Record one `j-rig review` curated-signal thumb + open-ended rationale.
 *
 * The row's `governance_class` is hard-set to `"curated-signal"`: this is a
 * developer-grade trust signal, explicitly NOT the signed in-toto `human-review/v1`
 * predicate and never a trust root (DR-103 D3 B3.2 / doc 072 R6). Any future signed
 * adjudication is a separate verb gated by the closed HR-1..HR-5 trigger set.
 */
export function recordSkillReview(
  { db }: JRigDatabase,
  input: RecordSkillReviewInput,
): SkillReviewRecord {
  const row = db
    .insert(skillHumanReviews)
    .values({
      skill_id: input.skillId,
      thumbs_up: input.thumbsUp,
      rationale: input.rationale ?? null,
      reviewer: input.reviewer,
      governance_class: "curated-signal",
      tenant_id: input.tenantId ?? null,
      recorded_at: input.recordedAt,
    })
    .returning()
    .get();
  return toReviewRecord(row);
}

// ── Rollups (C3-safe: per-dimension homogeneous counts only) ──────────────────

/**
 * A homogeneous per-source usage count for one skill. C3-safe (DR-103 C3 B6.1):
 * this is ONE labeled count for ONE (skill, source) pair — never a cross-dimension
 * scalar, never a blended "usefulness %".
 */
export interface VerifiedUsageCount {
  readonly skillId: string;
  readonly source: UsageEventSource;
  /** Tenant bucket; `null` = the global bucket (never pooled cross-tenant). */
  readonly tenantId: string | null;
  /** Count of CASS-PASSING rows for this (skill, source, tenant). */
  readonly verifiedCount: number;
}

/**
 * Count CASS-PASSING usage rows for a skill, partitioned by (source, tenant).
 *
 * Excludes failing rows (`cass_passed = 0`) — the persist-but-exclude discipline.
 * Partitions by tenant so an absent tenant (NULL) stays a distinct global bucket,
 * never pooled into a cross-tenant aggregate (DR-103 D2 B2.2). Returns ONE
 * homogeneous count per (source, tenant) — no cross-dimension rollup (C3).
 */
export function countVerifiedUsage(
  { db }: JRigDatabase,
  skillId: string,
): readonly VerifiedUsageCount[] {
  const rows = db
    .select()
    .from(skillUsageEvents)
    .where(eq(skillUsageEvents.skill_id, skillId))
    .all();

  // Partition: (source, tenant) → count of CASS-passing rows. NULL tenant is a
  // distinct bucket keyed on the empty-marker, never merged with a real tenant.
  const NULL_TENANT = " global";
  const counts = new Map<string, VerifiedUsageCount>();
  for (const r of rows) {
    if (!r.cass_passed) continue; // persist-but-exclude
    const tenant = r.tenant_id ?? null;
    const key = `${r.source}${tenant ?? NULL_TENANT}`;
    const existing = counts.get(key);
    if (existing) {
      counts.set(key, { ...existing, verifiedCount: existing.verifiedCount + 1 });
    } else {
      counts.set(key, {
        skillId,
        source: r.source as UsageEventSource,
        tenantId: tenant,
        verifiedCount: 1,
      });
    }
  }
  // Deterministic order: source, then tenant (null last).
  return [...counts.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    if (a.tenantId === b.tenantId) return 0;
    if (a.tenantId === null) return 1;
    if (b.tenantId === null) return -1;
    return a.tenantId < b.tenantId ? -1 : 1;
  });
}

/**
 * A homogeneous per-thumb review count for one skill. C3-safe: one labeled count
 * per (skill, thumb-direction, tenant) — never blended with usage or with the
 * other thumb direction.
 */
export interface ReviewCount {
  readonly skillId: string;
  /** `"up"` or `"down"` — kept as separate dimensions (never netted). */
  readonly direction: "up" | "down";
  readonly tenantId: string | null;
  readonly count: number;
}

/**
 * Count curated-signal reviews for a skill, partitioned by (thumb-direction,
 * tenant). Up and down are SEPARATE dimensions — never netted into a score (C3).
 */
export function countReviews({ db }: JRigDatabase, skillId: string): readonly ReviewCount[] {
  const rows = db
    .select()
    .from(skillHumanReviews)
    .where(eq(skillHumanReviews.skill_id, skillId))
    .all();

  const NULL_TENANT = " global";
  const counts = new Map<string, ReviewCount>();
  for (const r of rows) {
    const direction: "up" | "down" = r.thumbs_up ? "up" : "down";
    const tenant = r.tenant_id ?? null;
    const key = `${direction}${tenant ?? NULL_TENANT}`;
    const existing = counts.get(key);
    if (existing) {
      counts.set(key, { ...existing, count: existing.count + 1 });
    } else {
      counts.set(key, { skillId, direction, tenantId: tenant, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => {
    if (a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
    if (a.tenantId === b.tenantId) return 0;
    if (a.tenantId === null) return 1;
    if (b.tenantId === null) return -1;
    return a.tenantId < b.tenantId ? -1 : 1;
  });
}

// ── Row mappers ────────────────────────────────────────────────────────────────

type UsageRow = typeof skillUsageEvents.$inferSelect;
type ReviewRow = typeof skillHumanReviews.$inferSelect;

function toUsageRecord(row: UsageRow): SkillUsageRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    sessionId: row.session_id,
    source: row.source as UsageEventSource,
    cassScore: row.cass_score,
    cassPassed: row.cass_passed,
    tenantId: row.tenant_id ?? null,
    recordedAt: row.recorded_at,
  };
}

function toReviewRecord(row: ReviewRow): SkillReviewRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    thumbsUp: row.thumbs_up,
    rationale: row.rationale ?? null,
    reviewer: row.reviewer,
    governanceClass: "curated-signal",
    tenantId: row.tenant_id ?? null,
    recordedAt: row.recorded_at,
  };
}
