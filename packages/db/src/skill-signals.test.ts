import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createDatabase,
  type JRigDatabase,
  scoreCass,
  CASS_PASS_THRESHOLD,
  recordSkillUsage,
  recordSkillReview,
  countVerifiedUsage,
  countReviews,
} from "./index.js";

const AT = "2026-06-26T00:00:00.000Z";

describe("scoreCass — anti-gaming gate (DR-103 D5 B5.3, spec Item 5)", () => {
  it("an empty session scores 0 and FAILS (< 0.30)", () => {
    const r = scoreCass({});
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("tests-passed alone (0.25) FAILS (below the 0.30 threshold)", () => {
    const r = scoreCass({ testsPassed: true });
    expect(r.score).toBeCloseTo(0.25, 5);
    expect(r.passed).toBe(false);
  });

  it("tests-passed + clear-resolution (0.50) PASSES", () => {
    const r = scoreCass({ testsPassed: true, clearResolution: true });
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.passed).toBe(true);
  });

  it("penalties pull a borderline session below threshold", () => {
    // 0.25 + 0.15 = 0.40, then −0.20 abandoned ⇒ 0.20 < 0.30.
    const r = scoreCass({ testsPassed: true, codeChanges: true, abandoned: true });
    expect(r.score).toBeCloseTo(0.2, 5);
    expect(r.passed).toBe(false);
  });

  it("the pass threshold constant is 0.30", () => {
    expect(CASS_PASS_THRESHOLD).toBe(0.3);
  });
});

describe("recordSkillUsage — persist-but-exclude (spec Item 5)", () => {
  let database: JRigDatabase;
  beforeEach(() => {
    database = createDatabase(":memory:");
  });
  afterEach(() => database.close());

  it("persists a PASSING row and counts it", () => {
    recordSkillUsage(database, {
      skillId: "commit-writer",
      sessionId: "s1",
      source: "ci",
      cass: { testsPassed: true, clearResolution: true },
      recordedAt: AT,
    });
    const counts = countVerifiedUsage(database, "commit-writer");
    expect(counts).toHaveLength(1);
    expect(counts[0]!.verifiedCount).toBe(1);
    expect(counts[0]!.source).toBe("ci");
  });

  it("PERSISTS a failing row but EXCLUDES it from the verified count (load-to-inflate is visible)", () => {
    // A gamed "load in a loop" — no quality signals ⇒ CASS fails.
    recordSkillUsage(database, {
      skillId: "commit-writer",
      sessionId: "s-gamed",
      source: "plugin",
      cass: {}, // score 0, fails
      recordedAt: AT,
    });
    // The row IS persisted (not dropped)...
    const all = database.sqlite
      .prepare("SELECT COUNT(*) AS n FROM skill_usage_events WHERE skill_id = ?")
      .get("commit-writer") as { n: number };
    expect(all.n).toBe(1);
    // ...but it does NOT count toward verified usage.
    const counts = countVerifiedUsage(database, "commit-writer");
    expect(counts).toHaveLength(0);
  });

  it("records the source provenance split (ci vs plugin) on the row", () => {
    const rec = recordSkillUsage(database, {
      skillId: "x",
      sessionId: "s",
      source: "plugin",
      cass: { testsPassed: true, clearResolution: true },
      recordedAt: AT,
    });
    expect(rec.source).toBe("plugin");
    expect(rec.cassPassed).toBe(true);
  });
});

describe("countVerifiedUsage — tenant partition (DR-103 D2 B2.2)", () => {
  let database: JRigDatabase;
  beforeEach(() => {
    database = createDatabase(":memory:");
  });
  afterEach(() => database.close());

  it("an absent tenant is a distinct global bucket, never pooled with a real tenant", () => {
    const pass = { testsPassed: true, clearResolution: true };
    recordSkillUsage(database, {
      skillId: "k",
      sessionId: "g1",
      source: "ci",
      cass: pass,
      recordedAt: AT,
    });
    recordSkillUsage(database, {
      skillId: "k",
      sessionId: "t1",
      source: "ci",
      cass: pass,
      tenantId: "tenant-a",
      recordedAt: AT,
    });
    const counts = countVerifiedUsage(database, "k");
    const global = counts.find((c) => c.tenantId === null)!;
    const a = counts.find((c) => c.tenantId === "tenant-a")!;
    expect(global.verifiedCount).toBe(1);
    expect(a.verifiedCount).toBe(1);
  });

  it("returns per-(source,tenant) homogeneous counts only — no cross-dimension scalar (C3)", () => {
    const pass = { testsPassed: true, clearResolution: true };
    recordSkillUsage(database, {
      skillId: "k",
      sessionId: "c1",
      source: "ci",
      cass: pass,
      recordedAt: AT,
    });
    recordSkillUsage(database, {
      skillId: "k",
      sessionId: "c2",
      source: "ci",
      cass: pass,
      recordedAt: AT,
    });
    recordSkillUsage(database, {
      skillId: "k",
      sessionId: "p1",
      source: "plugin",
      cass: pass,
      recordedAt: AT,
    });
    const counts = countVerifiedUsage(database, "k");
    const ci = counts.find((c) => c.source === "ci")!;
    const plugin = counts.find((c) => c.source === "plugin")!;
    expect(ci.verifiedCount).toBe(2);
    expect(plugin.verifiedCount).toBe(1);
    // Each entry is ONE labeled count — there is no blended total field.
    for (const c of counts) {
      expect(c).not.toHaveProperty("total");
      expect(c).not.toHaveProperty("score");
    }
  });
});

describe("recordSkillReview + countReviews — curated-signal (DR-103 D3 B3.2 / doc 072 R6)", () => {
  let database: JRigDatabase;
  beforeEach(() => {
    database = createDatabase(":memory:");
  });
  afterEach(() => database.close());

  it("records a thumb + rationale as a curated-signal row (NOT a signed predicate)", () => {
    const rec = recordSkillReview(database, {
      skillId: "commit-writer",
      thumbsUp: true,
      rationale: "saved me time",
      reviewer: "jeremy@intentsolutions.io",
      recordedAt: AT,
    });
    expect(rec.governanceClass).toBe("curated-signal");
    expect(rec.thumbsUp).toBe(true);
    expect(rec.rationale).toBe("saved me time");
  });

  it("counts up and down thumbs as SEPARATE dimensions, never netted into a score (C3)", () => {
    recordSkillReview(database, { skillId: "k", thumbsUp: true, reviewer: "a", recordedAt: AT });
    recordSkillReview(database, { skillId: "k", thumbsUp: true, reviewer: "b", recordedAt: AT });
    recordSkillReview(database, { skillId: "k", thumbsUp: false, reviewer: "c", recordedAt: AT });
    const counts = countReviews(database, "k");
    const up = counts.find((c) => c.direction === "up")!;
    const down = counts.find((c) => c.direction === "down")!;
    expect(up.count).toBe(2);
    expect(down.count).toBe(1);
    // No net "score" — up and down stay orthogonal.
    expect(counts).not.toHaveProperty("net");
  });

  it("a null rationale is allowed (thumb-only review)", () => {
    const rec = recordSkillReview(database, {
      skillId: "k",
      thumbsUp: false,
      reviewer: "a",
      recordedAt: AT,
    });
    expect(rec.rationale).toBeNull();
  });
});
