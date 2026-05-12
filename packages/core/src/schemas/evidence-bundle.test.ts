import { describe, it, expect } from "vitest";
import {
  GateResultPredicateSchema,
  EvidenceStatementSchema,
  EvidenceBundleSchema,
  PREDICATE_URI,
  STATEMENT_TYPE,
  GATE_ID_REGEX,
  SHA256_PREFIXED_REGEX,
  RUNNER_REGEX,
  COMMIT_SHA_REGEX,
} from "./evidence-bundle.js";

const SHA = "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";
const VALID_PREDICATE = {
  gate_id: "audit-harness:ci:escape-scan",
  result: "PASS" as const,
  policy_hash: `sha256:${SHA}`,
  input_hash: `sha256:${SHA}`,
  timestamp: "2026-05-12T03:24:04Z",
  runner: "audit-harness@0.3.0",
  commit_sha: "abc1234",
};
const VALID_STATEMENT = {
  _type: STATEMENT_TYPE,
  subject: [{ name: VALID_PREDICATE.gate_id, digest: { sha256: SHA } }],
  predicateType: PREDICATE_URI,
  predicate: VALID_PREDICATE,
};

describe("constants", () => {
  it("PREDICATE_URI matches the SPEC.md frozen value", () => {
    expect(PREDICATE_URI).toBe("https://evals.intentsolutions.io/gate-result/v1");
  });
  it("STATEMENT_TYPE matches the in-toto Statement v1 URI", () => {
    expect(STATEMENT_TYPE).toBe("https://in-toto.io/Statement/v1");
  });
});

describe("GATE_ID_REGEX", () => {
  it("accepts well-formed lowercase tool + gate ids", () => {
    expect("audit-harness:ci:escape-scan").toMatch(GATE_ID_REGEX);
    expect("j-rig:server:crap-score").toMatch(GATE_ID_REGEX);
  });
  it("accepts mixed-case gate ids (MM-1..MM-6 convention)", () => {
    expect("j-rig:server:MM-1").toMatch(GATE_ID_REGEX);
    expect("j-rig:server:MM-3").toMatch(GATE_ID_REGEX);
    expect("intent-rollout-gate:ci:Decision").toMatch(GATE_ID_REGEX);
  });
  it("rejects uppercase tool name", () => {
    expect("AUDIT-HARNESS:ci:escape-scan").not.toMatch(GATE_ID_REGEX);
  });
  it("rejects unknown side", () => {
    expect("audit-harness:prod:escape-scan").not.toMatch(GATE_ID_REGEX);
  });
  it("rejects missing segments", () => {
    expect("audit-harness:escape-scan").not.toMatch(GATE_ID_REGEX);
    expect("escape-scan").not.toMatch(GATE_ID_REGEX);
  });
});

describe("SHA256_PREFIXED_REGEX", () => {
  it("requires sha256: prefix and exactly 64 lowercase hex chars", () => {
    expect(`sha256:${SHA}`).toMatch(SHA256_PREFIXED_REGEX);
  });
  it("rejects 63 hex chars (off-by-one)", () => {
    expect(`sha256:${SHA.slice(0, 63)}`).not.toMatch(SHA256_PREFIXED_REGEX);
  });
  it("rejects uppercase hex", () => {
    expect(`sha256:${SHA.toUpperCase()}`).not.toMatch(SHA256_PREFIXED_REGEX);
  });
  it("rejects missing prefix", () => {
    expect(SHA).not.toMatch(SHA256_PREFIXED_REGEX);
  });
});

describe("RUNNER_REGEX", () => {
  it("accepts tool@semver", () => {
    expect("audit-harness@0.3.0").toMatch(RUNNER_REGEX);
    expect("j-rig@0.15.0-rc.1").toMatch(RUNNER_REGEX);
    expect("intent-rollout-gate@0.1.0+build.42").toMatch(RUNNER_REGEX);
  });
  it("rejects missing version", () => {
    expect("audit-harness").not.toMatch(RUNNER_REGEX);
  });
  it("rejects non-semver version", () => {
    expect("audit-harness@latest").not.toMatch(RUNNER_REGEX);
  });
});

describe("COMMIT_SHA_REGEX", () => {
  it("accepts 7-hex (short)", () => {
    expect("abc1234").toMatch(COMMIT_SHA_REGEX);
  });
  it("accepts 40-hex (full)", () => {
    expect("abc1234567890abcdef1234567890abcdef12345").toMatch(COMMIT_SHA_REGEX);
  });
  it("rejects 6-hex (too short)", () => {
    expect("abc123").not.toMatch(COMMIT_SHA_REGEX);
  });
  it("rejects uppercase", () => {
    expect("ABC1234").not.toMatch(COMMIT_SHA_REGEX);
  });
});

describe("GateResultPredicateSchema", () => {
  it("accepts a complete valid predicate", () => {
    expect(GateResultPredicateSchema.safeParse(VALID_PREDICATE).success).toBe(true);
  });
  it("rejects missing required field (gate_id)", () => {
    const invalid = { ...VALID_PREDICATE };
    delete (invalid as { gate_id?: string }).gate_id;
    expect(GateResultPredicateSchema.safeParse(invalid).success).toBe(false);
  });
  it("rejects unknown extra fields (strict mode)", () => {
    const invalid = { ...VALID_PREDICATE, extra: "field" };
    expect(GateResultPredicateSchema.safeParse(invalid).success).toBe(false);
  });
  it("requires advisory_severity when result=ADVISORY", () => {
    const advisory = { ...VALID_PREDICATE, result: "ADVISORY" as const };
    const check = GateResultPredicateSchema.safeParse(advisory);
    expect(check.success).toBe(false);
    if (!check.success) {
      const msgs = check.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("advisory_severity"))).toBe(true);
    }
  });
  it("accepts ADVISORY when advisory_severity present", () => {
    const advisory = {
      ...VALID_PREDICATE,
      result: "ADVISORY" as const,
      advisory_severity: "warn" as const,
    };
    expect(GateResultPredicateSchema.safeParse(advisory).success).toBe(true);
  });
  it("rejects bad input_hash format", () => {
    const invalid = { ...VALID_PREDICATE, input_hash: "not-a-hash" };
    expect(GateResultPredicateSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("EvidenceStatementSchema cross-field invariants (SPEC § R8-R9)", () => {
  it("accepts the canonical valid statement", () => {
    const check = EvidenceStatementSchema.safeParse(VALID_STATEMENT);
    expect(check.success).toBe(true);
  });

  it("rejects subject.name != predicate.gate_id (R8)", () => {
    const invalid = {
      ...VALID_STATEMENT,
      subject: [{ name: "audit-harness:ci:other-gate", digest: { sha256: SHA } }],
    };
    const check = EvidenceStatementSchema.safeParse(invalid);
    expect(check.success).toBe(false);
    if (!check.success) {
      expect(check.error.issues.some((i) => i.message.includes("must equal predicate.gate_id"))).toBe(true);
    }
  });

  it("rejects subject.digest.sha256 != predicate.input_hash (R9)", () => {
    const wrongDigest = "0".repeat(64);
    const invalid = {
      ...VALID_STATEMENT,
      subject: [{ name: VALID_PREDICATE.gate_id, digest: { sha256: wrongDigest } }],
    };
    const check = EvidenceStatementSchema.safeParse(invalid);
    expect(check.success).toBe(false);
    if (!check.success) {
      expect(
        check.error.issues.some((i) => i.message.includes("must equal predicate.input_hash")),
      ).toBe(true);
    }
  });

  it("rejects wrong _type", () => {
    const invalid = { ...VALID_STATEMENT, _type: "https://wrong.example/Statement/v1" };
    expect(EvidenceStatementSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects wrong predicateType", () => {
    const invalid = {
      ...VALID_STATEMENT,
      predicateType: "https://evals.intentsolutions.io/gate-result/v2",
    };
    expect(EvidenceStatementSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects empty subject array", () => {
    const invalid = { ...VALID_STATEMENT, subject: [] };
    expect(EvidenceStatementSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("EvidenceBundleSchema container", () => {
  it("accepts empty rows", () => {
    expect(
      EvidenceBundleSchema.safeParse({ bundle_format: "json-array", rows: [] }).success,
    ).toBe(true);
  });
  it("accepts multi-row bundles", () => {
    const bundle = {
      bundle_format: "json-array" as const,
      rows: [VALID_STATEMENT, VALID_STATEMENT],
    };
    expect(EvidenceBundleSchema.safeParse(bundle).success).toBe(true);
  });
  it("propagates row-level invariant failures", () => {
    const badRow = {
      ...VALID_STATEMENT,
      subject: [{ name: "j-rig:server:other-gate", digest: { sha256: SHA } }],
    };
    const bundle = { bundle_format: "json-array" as const, rows: [VALID_STATEMENT, badRow] };
    expect(EvidenceBundleSchema.safeParse(bundle).success).toBe(false);
  });
  it("rejects wrong bundle_format literal", () => {
    expect(
      EvidenceBundleSchema.safeParse({ bundle_format: "jsonl", rows: [] }).success,
    ).toBe(false);
  });
});
