import { describe, it, expect } from "vitest";
import type { HumanReview, UsageEvent } from "@intentsolutions/core";
import {
  NO_ROLLED_ADOPTION_SCORE,
  PROVISIONAL_ADOPTION_THRESHOLDS,
  computeAdoptionVerdict,
  toAdoptionObservations,
  type AdoptionObservation,
  type AdoptionThresholds,
} from "./adoption.js";

// A fixed "now" so every test is deterministic (no wall clock).
const NOW = "2026-06-26T00:00:00.000Z";

/** Build an observation `daysAgo` before NOW. */
function obs(
  daysAgo: number,
  kept: 0 | 1,
  source: AdoptionObservation["source"] = "ci",
  tenantId?: string,
): AdoptionObservation {
  const at = new Date(Date.parse(NOW) - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { at, kept, source, ...(tenantId !== undefined ? { tenantId } : {}) };
}

/** Calibrated (non-provisional) thresholds with a small minVolume for tests. */
const CALIBRATED: AdoptionThresholds = {
  halfLifeDays: 30,
  minVolume: 1,
  highAdoptionRate: 0.6,
  lowAdoptionRate: 0.2,
  pluginSourceWeight: 0.1,
  provisional: false,
};

describe("computeAdoptionVerdict — 2×2 (baseline-value × adoption), AND-combined", () => {
  it("skill-adds-value + high adoption ⇒ keep", () => {
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations: [obs(0, 1), obs(1, 1), obs(2, 1)],
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(v.adoption).toBe("high");
    expect(v.verdict).toBe("keep");
  });

  it("skill-adds-value + low adoption ⇒ watch (discoverability problem)", () => {
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations: [obs(0, 0), obs(1, 0), obs(2, 0), obs(3, 0), obs(4, 1)],
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(v.adoption).toBe("low");
    expect(v.verdict).toBe("watch");
  });

  it("bare-model-matches + high adoption ⇒ deprecate_review (model caught up but used)", () => {
    const v = computeAdoptionVerdict({
      baselineValue: "bare-model-matches",
      observations: [obs(0, 1), obs(1, 1), obs(2, 1)],
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(v.adoption).toBe("high");
    expect(v.verdict).toBe("deprecate_review");
  });

  it("bare-model-matches + low adoption ⇒ obsolete_review (both axes agree)", () => {
    const v = computeAdoptionVerdict({
      baselineValue: "bare-model-matches",
      observations: [obs(0, 0), obs(1, 0), obs(2, 0), obs(3, 0), obs(4, 0)],
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(v.adoption).toBe("low");
    expect(v.verdict).toBe("obsolete_review");
  });

  it("inconclusive adoption ⇒ hold on BOTH baseline cases (never deprecate on weak evidence)", () => {
    // rate ≈ 0.5 — between low (0.2) and high (0.6).
    const mixed = [obs(0, 1), obs(0, 0)];
    const addsValue = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations: mixed,
      now: NOW,
      thresholds: CALIBRATED,
    });
    const matches = computeAdoptionVerdict({
      baselineValue: "bare-model-matches",
      observations: mixed,
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(addsValue.adoption).toBe("inconclusive");
    expect(addsValue.verdict).toBe("hold");
    expect(matches.verdict).toBe("hold");
  });

  it("insufficient evidence (no tenant clears minVolume) ⇒ hold, decayedRate null", () => {
    const v = computeAdoptionVerdict({
      baselineValue: "bare-model-matches",
      observations: [obs(0, 1)], // weight 1.0, but minVolume is 3
      now: NOW,
      thresholds: PROVISIONAL_ADOPTION_THRESHOLDS, // minVolume 3
    });
    expect(v.adoption).toBe("insufficient");
    expect(v.verdict).toBe("hold");
    expect(v.decayedRate).toBeNull();
  });
});

describe("computeAdoptionVerdict — DETERMINISM (DR-103 D5 B5.1)", () => {
  it("is a pure function: identical inputs ⇒ deeply-equal output", () => {
    const args = {
      baselineValue: "skill-adds-value" as const,
      observations: [obs(0, 1), obs(5, 1), obs(10, 0)],
      now: NOW,
      thresholds: CALIBRATED,
    };
    const a = computeAdoptionVerdict(args);
    const b = computeAdoptionVerdict(args);
    expect(a).toEqual(b);
  });

  it("stamps evaluatedAt with the INJECTED now, never the wall clock", () => {
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations: [obs(0, 1)],
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(v.evaluatedAt).toBe(NOW);
  });

  it("a future-dated observation is clamped to age 0 (no negative decay blowup)", () => {
    const future = new Date(Date.parse(NOW) + 5 * 24 * 60 * 60 * 1000).toISOString();
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations: [{ at: future, kept: 1, source: "ci" }],
      now: NOW,
      thresholds: CALIBRATED,
    });
    // Clamped to weight 1.0, counted, rate 1.0.
    expect(v.decayedRate).toBe(1);
  });
});

describe("computeAdoptionVerdict — time decay", () => {
  it("an older observation carries less weight than a recent one (recency bias)", () => {
    // One recent 'kept', one old 'abandoned'. The decayed rate should be > 0.5
    // because the recent kept observation dominates.
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations: [obs(0, 1), obs(120, 0)], // 120 days = 4 half-lives of decay
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(v.decayedRate).not.toBeNull();
    expect(v.decayedRate!).toBeGreaterThan(0.5);
  });

  it("at exactly one half-life an observation contributes half-weight", () => {
    // 1 kept today (weight 1.0) + 1 abandoned at 30d (weight 0.5).
    // rate = (1*1 + 0.5*0) / (1 + 0.5) = 1/1.5 ≈ 0.667.
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations: [obs(0, 1), obs(30, 0)],
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(v.decayedRate!).toBeCloseTo(2 / 3, 5);
  });
});

describe("computeAdoptionVerdict — source segregation (DR-103 D5 B5.3)", () => {
  it("plugin (unverified) observations are weighted near zero vs ci", () => {
    // 10 plugin 'kept' (weight 0.1 each = 1.0 total) vs 1 ci 'abandoned' (weight 1.0).
    // If plugin were full-weight the rate would be ~0.91; with the 0.1 discount the
    // ci abandonment is comparable, pulling the rate down to ~0.5.
    const observations: AdoptionObservation[] = [
      ...Array.from({ length: 10 }, () => obs(0, 1, "plugin")),
      obs(0, 0, "ci"),
    ];
    const v = computeAdoptionVerdict({
      baselineValue: "bare-model-matches",
      observations,
      now: NOW,
      thresholds: CALIBRATED,
    });
    // ci abandonment (weight 1.0) ≈ plugin kept total (10 * 0.1 = 1.0) ⇒ ~0.5.
    expect(v.decayedRate!).toBeCloseTo(0.5, 5);
  });

  it("a zero pluginSourceWeight drops plugin observations entirely", () => {
    const observations: AdoptionObservation[] = [
      obs(0, 1, "plugin"),
      obs(0, 1, "plugin"),
      obs(0, 1, "ci"),
    ];
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations,
      now: NOW,
      thresholds: { ...CALIBRATED, pluginSourceWeight: 0 },
    });
    // Only the single ci observation counts (weight 1.0, kept) ⇒ rate 1.0.
    expect(v.evidenceWeight).toBeCloseTo(1, 5);
    expect(v.decayedRate).toBe(1);
  });
});

describe("computeAdoptionVerdict — per-tenant first, bounded aggregate (DR-103 D2/D5)", () => {
  it("excludes a tenant below its own minVolume (held, not averaged in as noise)", () => {
    // Tenant A: 3 kept (weight 3.0 ≥ minVolume 3) ⇒ counted, rate 1.0.
    // Tenant B: 1 abandoned (weight 1.0 < 3) ⇒ EXCLUDED.
    const observations: AdoptionObservation[] = [
      obs(0, 1, "ci", "tenant-a"),
      obs(0, 1, "ci", "tenant-a"),
      obs(0, 1, "ci", "tenant-a"),
      obs(0, 0, "ci", "tenant-b"),
    ];
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations,
      now: NOW,
      thresholds: PROVISIONAL_ADOPTION_THRESHOLDS, // minVolume 3
    });
    const a = v.perTenant.find((t) => t.tenantId === "tenant-a")!;
    const b = v.perTenant.find((t) => t.tenantId === "tenant-b")!;
    expect(a.counted).toBe(true);
    expect(a.decayedRate).toBe(1);
    expect(b.counted).toBe(false);
    expect(b.decayedRate).toBeNull();
    // Cross-tenant rate reflects ONLY tenant A (B's abandonment did not drag it down).
    expect(v.decayedRate).toBe(1);
    expect(v.verdict).toBe("keep");
  });

  it("an absent tenant_id is a first-class global bucket, never pooled cross-tenant", () => {
    const observations: AdoptionObservation[] = [
      obs(0, 1, "ci"), // global
      obs(0, 1, "ci"), // global
      obs(0, 1, "ci"), // global
      obs(0, 0, "ci", "tenant-a"),
      obs(0, 0, "ci", "tenant-a"),
      obs(0, 0, "ci", "tenant-a"),
    ];
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations,
      now: NOW,
      thresholds: PROVISIONAL_ADOPTION_THRESHOLDS,
    });
    const global = v.perTenant.find((t) => t.tenantId === null)!;
    const a = v.perTenant.find((t) => t.tenantId === "tenant-a")!;
    expect(global.decayedRate).toBe(1);
    expect(a.decayedRate).toBe(0);
    // Both counted; cross-tenant weighted mean = (3*1 + 3*0)/6 = 0.5 ⇒ inconclusive.
    expect(v.decayedRate).toBeCloseTo(0.5, 5);
  });
});

describe("computeAdoptionVerdict — provisional flag (DR-103 D5 B5.2)", () => {
  it("propagates thresholdsProvisional=true from the shipped defaults", () => {
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations: [obs(0, 1), obs(1, 1), obs(2, 1)],
      now: NOW,
      // default PROVISIONAL_ADOPTION_THRESHOLDS
    });
    expect(v.thresholdsProvisional).toBe(true);
  });

  it("propagates thresholdsProvisional=false for calibrated thresholds", () => {
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations: [obs(0, 1)],
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(v.thresholdsProvisional).toBe(false);
  });
});

describe("computeAdoptionVerdict — C3: no rolled score (DR-103 C3 B6.1)", () => {
  it("the no-reduce marker is asserted true", () => {
    expect(NO_ROLLED_ADOPTION_SCORE).toBe(true);
  });

  it("the verdict carries NO single 'usefulness %' field — only per-dimension data", () => {
    const v = computeAdoptionVerdict({
      baselineValue: "bare-model-matches",
      observations: [obs(0, 1), obs(1, 1), obs(2, 1)],
      now: NOW,
      thresholds: CALIBRATED,
    });
    // The keys are the two axes + the joined verdict + provenance — NO scalar that
    // blends the baseline-value axis and the adoption axis into one number.
    expect(v).not.toHaveProperty("usefulness");
    expect(v).not.toHaveProperty("score");
    expect(v).not.toHaveProperty("rolledScore");
    expect(v).not.toHaveProperty("aggregate");
    // decayedRate is the SINGLE adoption dimension's rate (input to the axis),
    // explicitly NOT a blend of the two axes.
    expect(v.baselineValue).toBeDefined();
    expect(v.adoption).toBeDefined();
  });

  it("is explainable: carries decayed weight + per-tenant breakdown + evaluatedAt (D5 B5.4)", () => {
    const v = computeAdoptionVerdict({
      baselineValue: "bare-model-matches",
      observations: [obs(0, 1, "ci", "t1"), obs(1, 0, "ci", "t1")],
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(v.evidenceWeight).toBeGreaterThan(0);
    expect(v.perTenant.length).toBeGreaterThan(0);
    expect(v.evaluatedAt).toBe(NOW);
  });
});

// ── Adapter: kernel rows → observations (anti-gaming re-check, DR-103 D5 B5.3) ──

function uuid(n: number): string {
  return `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
}

function usageRow(over: Partial<UsageEvent>): UsageEvent {
  return {
    id: uuid(1) as UsageEvent["id"],
    meter: "skill_invocation",
    quantity: 1,
    unit: "count",
    source_entity_type: "session_trace",
    source_entity_id: uuid(2) as UsageEvent["source_entity_id"],
    source_verified: true,
    cost_record_ref: null,
    recorded_at: NOW as UsageEvent["recorded_at"],
    ...over,
  } as UsageEvent;
}

describe("toAdoptionObservations — anti-gaming re-check at ingestion", () => {
  it("keeps a verified, metered (non-api_call) row with a gated source", () => {
    const out = toAdoptionObservations({
      usageEvents: [usageRow({})],
      sourceOf: () => "ci",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kept).toBe(1);
    expect(out[0]!.source).toBe("ci");
  });

  it("DROPS a row whose source_verified is not true (kernel invariant re-asserted)", () => {
    const out = toAdoptionObservations({
      usageEvents: [usageRow({ source_verified: false })],
    });
    expect(out).toHaveLength(0);
  });

  it("DROPS an api_call row (leaf provider action, not skill adoption signal)", () => {
    const out = toAdoptionObservations({
      usageEvents: [
        usageRow({ meter: "api_call", source_entity_type: null, source_entity_id: null }),
      ],
    });
    expect(out).toHaveLength(0);
  });

  it("DROPS a row with a null source_entity_id (no gated provenance)", () => {
    const out = toAdoptionObservations({
      usageEvents: [usageRow({ source_entity_id: null })],
    });
    expect(out).toHaveLength(0);
  });

  it("defaults an unmapped source to 'plugin' (conservative low-trust assumption)", () => {
    const out = toAdoptionObservations({ usageEvents: [usageRow({})] });
    expect(out[0]!.source).toBe("plugin");
  });

  it("a thumbs-down HumanReview pinned to the session flips kept → 0", () => {
    const sessionId = uuid(2);
    const review: HumanReview = {
      id: uuid(9) as HumanReview["id"],
      eval_run_id: uuid(10) as HumanReview["eval_run_id"],
      session_trace_id: sessionId as HumanReview["session_trace_id"],
      judge_decision_id: null,
      supersedes_id: null,
      reviewer_identity: "jeremy@intentsolutions.io" as HumanReview["reviewer_identity"],
      reviewer_is_service_account: false,
      score_text: null,
      thumbs: false,
      annotation: "did not help",
      input_hash: "a".repeat(64) as HumanReview["input_hash"],
      created_at: NOW as HumanReview["created_at"],
    };
    const out = toAdoptionObservations({
      usageEvents: [usageRow({ source_entity_id: sessionId as UsageEvent["source_entity_id"] })],
      humanReviews: [review],
      sourceOf: () => "ci",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kept).toBe(0);
  });

  it("carries the tenant_id through onto the observation when present", () => {
    const out = toAdoptionObservations({
      usageEvents: [usageRow({ tenant_id: uuid(3) as UsageEvent["tenant_id"] })],
    });
    expect(out[0]!.tenantId).toBe(uuid(3));
  });

  it("end-to-end: verified ci usage rows feed a keep verdict", () => {
    const events = [
      usageRow({ id: uuid(11) as UsageEvent["id"], recorded_at: NOW as UsageEvent["recorded_at"] }),
      usageRow({ id: uuid(12) as UsageEvent["id"], recorded_at: NOW as UsageEvent["recorded_at"] }),
      usageRow({ id: uuid(13) as UsageEvent["id"], recorded_at: NOW as UsageEvent["recorded_at"] }),
    ];
    const observations = toAdoptionObservations({ usageEvents: events, sourceOf: () => "ci" });
    const v = computeAdoptionVerdict({
      baselineValue: "skill-adds-value",
      observations,
      now: NOW,
      thresholds: CALIBRATED,
    });
    expect(v.verdict).toBe("keep");
  });
});
