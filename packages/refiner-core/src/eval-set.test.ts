/**
 * eval-set.test.ts — EvalSet versioning, lineage, ref derivation, refresh-due.
 *
 * Bead: bd_000-projects-214c.10 (P0)
 * Covers:
 *   - EvalSetSchema: valid EvalSet passes; each malformed field is rejected with
 *     a clear, path-annotated error.
 *   - validateEvalSet(): reject / pass semantics.
 *   - deriveEvalSetRef(): deterministic, sha256-prefixed, correct predicate shape.
 *   - content_hash change detection: deriveEvalSetRef().hash changes iff content changes.
 *   - isRefreshDue(): clock-injected; past/future/null/treatNullAsDue.
 *   - EvalSetRefSchema: rejects bad hash prefix, bad lineage_id, empty version.
 *   - bootstrap() lineageId: deterministic for root sets; propagated for child sets.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  validateEvalSet,
  deriveEvalSetRef,
  isRefreshDue,
  EvalSetRefSchema,
  UUIDV7_REGEX,
  SHA256_PREFIXED_REGEX,
} from "./eval-set.js";
import { bootstrap } from "./bootstrap.js";
import { makeSkillDoc } from "./apply.js";
import type { EvalSet } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_HASH = "a".repeat(64);
const VALID_LINEAGE_ID = "0192cae6-0001-7000-8000-000000000000";
const VALID_ITEM = { id: "skill-syn-001", prompt: "Use this skill to validate input." };

/** Minimal valid EvalSet value. */
function validEvalSet(overrides: Partial<EvalSet> = {}): unknown {
  return {
    hash: VALID_HASH,
    skillId: "validate-skillmd",
    source: "synthetic" as const,
    items: [VALID_ITEM],
    evalSetVersion: "1.0.0",
    lineageParent: null,
    refreshDueAt: "2026-09-15T00:00:00.000Z",
    lineageId: VALID_LINEAGE_ID,
    ...overrides,
  };
}

/** Extract the first ZodError message from a thrown ZodError. */
function zodMessages(e: unknown): string[] {
  if (e instanceof z.ZodError) {
    return e.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  }
  throw e;
}

// ─── validateEvalSet ──────────────────────────────────────────────────────────

describe("validateEvalSet", () => {
  it("accepts a fully valid EvalSet", () => {
    const result = validateEvalSet(validEvalSet());
    expect(result.skillId).toBe("validate-skillmd");
    expect(result.lineageId).toBe(VALID_LINEAGE_ID);
  });

  it("accepts a valid EvalSet with null refreshDueAt (quick mode)", () => {
    expect(() => validateEvalSet(validEvalSet({ refreshDueAt: null }))).not.toThrow();
  });

  it("accepts a valid EvalSet with a lineageParent", () => {
    expect(() => validateEvalSet(validEvalSet({ lineageParent: "b".repeat(64) }))).not.toThrow();
  });

  it("rejects a missing hash", () => {
    const v = validEvalSet() as Record<string, unknown>;
    delete v["hash"];
    const msgs = zodMessages(tryParse(v));
    expect(msgs.some((m) => m.includes("hash"))).toBe(true);
  });

  it("rejects a malformed hash (not 64 hex chars)", () => {
    const msgs = zodMessages(tryParse(validEvalSet({ hash: "abc" })));
    expect(msgs.some((m) => m.includes("hash"))).toBe(true);
  });

  it("rejects a hash with sha256: prefix (must be bare)", () => {
    const msgs = zodMessages(tryParse(validEvalSet({ hash: "sha256:" + "a".repeat(64) })));
    expect(msgs.some((m) => m.includes("hash"))).toBe(true);
  });

  it("rejects an empty skillId", () => {
    const msgs = zodMessages(tryParse(validEvalSet({ skillId: "" })));
    expect(msgs.some((m) => m.includes("skillId"))).toBe(true);
  });

  it("rejects an invalid source value", () => {
    const msgs = zodMessages(tryParse(validEvalSet({ source: "unknown" as never })));
    expect(msgs.some((m) => m.includes("source"))).toBe(true);
  });

  it("rejects an empty items array", () => {
    const msgs = zodMessages(tryParse(validEvalSet({ items: [] })));
    expect(msgs.some((m) => m.includes("items"))).toBe(true);
  });

  it("rejects an empty evalSetVersion", () => {
    const msgs = zodMessages(tryParse(validEvalSet({ evalSetVersion: "" })));
    expect(msgs.some((m) => m.includes("evalSetVersion"))).toBe(true);
  });

  it("rejects a malformed lineageParent (not 64 hex chars)", () => {
    const msgs = zodMessages(tryParse(validEvalSet({ lineageParent: "not-a-hash" })));
    expect(msgs.some((m) => m.includes("lineageParent"))).toBe(true);
  });

  it("rejects a malformed refreshDueAt (not ISO-8601)", () => {
    const msgs = zodMessages(tryParse(validEvalSet({ refreshDueAt: "not-a-date" })));
    expect(msgs.some((m) => m.includes("refreshDueAt"))).toBe(true);
  });

  it("rejects a missing lineageId", () => {
    const v = validEvalSet() as Record<string, unknown>;
    delete v["lineageId"];
    const msgs = zodMessages(tryParse(v));
    expect(msgs.some((m) => m.includes("lineageId"))).toBe(true);
  });

  it("rejects a malformed lineageId (not UUIDv7)", () => {
    const msgs = zodMessages(tryParse(validEvalSet({ lineageId: "not-a-uuid" })));
    expect(msgs.some((m) => m.includes("lineageId"))).toBe(true);
  });

  it("rejects a UUIDv4 lineageId (wrong version nibble)", () => {
    // UUIDv4 has version nibble `4`, not `7`
    const uuidv4 = "0192cae6-0001-4000-8000-000000000000";
    const msgs = zodMessages(tryParse(validEvalSet({ lineageId: uuidv4 })));
    expect(msgs.some((m) => m.includes("lineageId"))).toBe(true);
  });
});

// ─── deriveEvalSetRef ─────────────────────────────────────────────────────────

describe("deriveEvalSetRef", () => {
  it("is deterministic: same EvalSet → identical EvalSetRef", () => {
    const es = validateEvalSet(validEvalSet()) as EvalSet;
    const ref1 = deriveEvalSetRef(es);
    const ref2 = deriveEvalSetRef(es);
    expect(ref1).toEqual(ref2);
  });

  it("produces hash in sha256-prefixed form matching the predicate spec", () => {
    const es = validateEvalSet(validEvalSet()) as EvalSet;
    const ref = deriveEvalSetRef(es);
    expect(ref.hash).toMatch(SHA256_PREFIXED_REGEX);
    expect(ref.hash).toBe(`sha256:${es.hash}`);
  });

  it("maps version to the EvalSet's evalSetVersion", () => {
    const es = validateEvalSet(validEvalSet({ evalSetVersion: "2.3.1" })) as EvalSet;
    expect(deriveEvalSetRef(es).version).toBe("2.3.1");
  });

  it("maps lineage_id to the EvalSet's lineageId", () => {
    const es = validateEvalSet(validEvalSet()) as EvalSet;
    expect(deriveEvalSetRef(es).lineage_id).toBe(VALID_LINEAGE_ID);
  });

  it("changes hash iff content (hash field) changes", () => {
    const es1 = validateEvalSet(validEvalSet({ hash: "a".repeat(64) })) as EvalSet;
    const es2 = validateEvalSet(validEvalSet({ hash: "b".repeat(64) })) as EvalSet;
    expect(deriveEvalSetRef(es1).hash).not.toBe(deriveEvalSetRef(es2).hash);
  });

  it("the derived ref satisfies EvalSetRefSchema", () => {
    const es = validateEvalSet(validEvalSet()) as EvalSet;
    const ref = deriveEvalSetRef(es);
    expect(() => EvalSetRefSchema.parse(ref)).not.toThrow();
  });

  it("rejects an invalid EvalSet (throws ZodError)", () => {
    expect(() => deriveEvalSetRef({ hash: "bad" } as EvalSet)).toThrow(z.ZodError);
  });
});

// ─── EvalSetRefSchema ─────────────────────────────────────────────────────────

describe("EvalSetRefSchema", () => {
  const validRef = {
    hash: "sha256:" + "c".repeat(64),
    version: "1.0.0",
    lineage_id: VALID_LINEAGE_ID,
  };

  it("accepts a valid EvalSetRef", () => {
    expect(() => EvalSetRefSchema.parse(validRef)).not.toThrow();
  });

  it("rejects hash missing sha256: prefix", () => {
    expect(() => EvalSetRefSchema.parse({ ...validRef, hash: "c".repeat(64) })).toThrow(z.ZodError);
  });

  it("rejects hash with wrong prefix", () => {
    expect(() => EvalSetRefSchema.parse({ ...validRef, hash: "md5:" + "c".repeat(32) })).toThrow(
      z.ZodError,
    );
  });

  it("rejects empty version", () => {
    expect(() => EvalSetRefSchema.parse({ ...validRef, version: "" })).toThrow(z.ZodError);
  });

  it("rejects malformed lineage_id", () => {
    expect(() => EvalSetRefSchema.parse({ ...validRef, lineage_id: "not-a-uuid" })).toThrow(
      z.ZodError,
    );
  });

  it("rejects unknown extra fields (additionalProperties: false semantics)", () => {
    expect(() => EvalSetRefSchema.parse({ ...validRef, extra: "field" })).toThrow(z.ZodError);
  });
});

// ─── isRefreshDue ─────────────────────────────────────────────────────────────

describe("isRefreshDue", () => {
  function es(refreshDueAt: string | null): EvalSet {
    return validateEvalSet(validEvalSet({ refreshDueAt })) as EvalSet;
  }

  it("returns true when refreshDueAt is in the past", () => {
    const past = "2020-01-01T00:00:00.000Z";
    expect(isRefreshDue(es(past), { now: "2026-06-20T00:00:00.000Z" })).toBe(true);
  });

  it("returns false when refreshDueAt is in the future", () => {
    const future = "2099-01-01T00:00:00.000Z";
    expect(isRefreshDue(es(future), { now: "2026-06-20T00:00:00.000Z" })).toBe(false);
  });

  it("returns true when now === refreshDueAt (exactly due)", () => {
    const ts = "2026-09-15T00:00:00.000Z";
    expect(isRefreshDue(es(ts), { now: ts })).toBe(true);
  });

  it("returns false for null refreshDueAt by default (quick mode sets are not considered due)", () => {
    expect(isRefreshDue(es(null), { now: "2026-06-20T00:00:00.000Z" })).toBe(false);
  });

  it("returns true for null refreshDueAt with treatNullAsDue: true", () => {
    expect(
      isRefreshDue(es(null), {
        now: "2026-06-20T00:00:00.000Z",
        treatNullAsDue: true,
      }),
    ).toBe(true);
  });
});

// ─── bootstrap lineageId integration ─────────────────────────────────────────

describe("bootstrap — lineageId", () => {
  const DOC_TEXT = `---
name: demo
description: a demo skill
---

# Demo Skill

Use this skill to validate and normalize input.
Always check the schema before processing.
- Reject malformed payloads with a clear error.
`;

  it("generates a syntactically valid UUIDv7 lineageId for root sets", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const set = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    expect(set.lineageId).toMatch(UUIDV7_REGEX);
  });

  it("lineageId is deterministic for the same skillId + source", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const set1 = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    const set2 = bootstrap(doc, { now: "2026-08-01T00:00:00.000Z" }); // different now
    // lineageId must not change when only the timestamp changes
    expect(set1.lineageId).toBe(set2.lineageId);
  });

  it("lineageId is stable across different evalSetVersion bumps", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const root = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    const child = bootstrap(doc, {
      evalSetVersion: "2.0.0",
      lineageParent: root.hash,
      lineageId: root.lineageId, // propagate lineage
      now: "2026-06-18T00:00:00.000Z",
    });
    expect(child.lineageId).toBe(root.lineageId);
  });

  it("lineageId differs for different skillIds", () => {
    const doc1 = makeSkillDoc("skill-a", DOC_TEXT);
    const doc2 = makeSkillDoc("skill-b", DOC_TEXT);
    const set1 = bootstrap(doc1, { now: "2026-06-17T00:00:00.000Z" });
    const set2 = bootstrap(doc2, { now: "2026-06-17T00:00:00.000Z" });
    expect(set1.lineageId).not.toBe(set2.lineageId);
  });

  it("the bootstrap output passes validateEvalSet", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const set = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    expect(() => validateEvalSet(set)).not.toThrow();
  });

  it("deriveEvalSetRef on a bootstrapped set satisfies the predicate shape", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const set = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    const ref = deriveEvalSetRef(set);
    expect(ref.hash).toMatch(SHA256_PREFIXED_REGEX);
    expect(ref.version).toBe("1.0.0");
    expect(ref.lineage_id).toMatch(UUIDV7_REGEX);
    // Full ref must satisfy the EvalSetRefSchema
    expect(() => EvalSetRefSchema.parse(ref)).not.toThrow();
  });
});

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Parse and catch — returns the thrown error, or throws if it didn't. */
function tryParse(value: unknown): unknown {
  try {
    validateEvalSet(value);
    throw new Error("Expected validateEvalSet to throw but it did not");
  } catch (e) {
    return e;
  }
}
