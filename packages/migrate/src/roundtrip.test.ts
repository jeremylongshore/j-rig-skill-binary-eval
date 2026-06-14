import { describe, it, expect } from "vitest";
import { EvidenceStatementSchema } from "@j-rig/core";
import { migrateStatement } from "./transform.js";

/**
 * The load-bearing guarantee: a migrated v1 row must VALIDATE against the real
 * kernel `gate-result/v1` schema (the same schema the rollout gate enforces).
 * A migration that produces schema-invalid rows is worthless, so this test
 * gates the field defaults the transform fills in.
 */
function v1Statement(result: string): unknown {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "j-rig:ci:MM-1", digest: { sha256: "a".repeat(64) } }],
    predicateType: "https://evals.intentsolutions.io/gate-result/v1",
    predicate: {
      gate_id: "j-rig:ci:MM-1",
      result,
      policy_hash: `sha256:${"c".repeat(64)}`,
      input_hash: `sha256:${"a".repeat(64)}`,
      timestamp: "2026-06-13T00:00:00.000Z",
      runner: "j-rig@2.0.0",
      commit_sha: "abc1234",
    },
  };
}

describe("migrated rows validate against the kernel schema", () => {
  it("a migrated PASS row passes EvidenceStatementSchema", () => {
    const { value } = migrateStatement(v1Statement("PASS"), 0);
    const parsed = EvidenceStatementSchema.safeParse(value);
    expect(parsed.success).toBe(true);
  });

  it("a migrated FAIL row passes EvidenceStatementSchema", () => {
    const { value } = migrateStatement(v1Statement("FAIL"), 0);
    expect(EvidenceStatementSchema.safeParse(value).success).toBe(true);
  });

  it("a migrated NOT_APPLICABLE-routed row passes EvidenceStatementSchema", () => {
    const { value } = migrateStatement(v1Statement("NOT_APPLICABLE"), 0);
    const parsed = EvidenceStatementSchema.safeParse(value);
    expect(parsed.success).toBe(true);
  });
});
