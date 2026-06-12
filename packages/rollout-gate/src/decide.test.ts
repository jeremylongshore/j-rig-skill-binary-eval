import { describe, it, expect } from "vitest";
import { PREDICATE_URI, STATEMENT_TYPE, type GateResult } from "@j-rig/core";
import { decide, parseBundle } from "./decide.js";
import type { RolloutPolicyInput } from "./policy.js";

const SHA = "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";

interface StatementOptions {
  gateId?: string;
  decision?: GateResult;
}

/** Build a schema-valid gate-result/v1 in-toto Statement (I1 + I2 satisfied). */
function makeStatement(opts: StatementOptions = {}): Record<string, unknown> {
  const gateId = opts.gateId ?? "audit-harness:ci:escape-scan";
  const decision = opts.decision ?? "pass";
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: gateId, digest: { sha256: SHA } }],
    predicateType: PREDICATE_URI,
    predicate: {
      gate_id: gateId,
      gate_name: "escape-scan",
      gate_version: "2.0.0",
      gate_decision: decision,
      ...(decision === "advisory" ? { advisory_severity: "warn" } : {}),
      gate_reasons: ["fixture"],
      coverage: { dimensions_evaluated: ["lines"], dimensions_skipped: [] },
      policy_ref: `sha256:${SHA}:vitest.config.ts`,
      policy_hash: `sha256:${SHA}`,
      input_hash: `sha256:${SHA}`,
      evaluated_at: "2026-05-12T03:24:04Z",
      runner: "audit-harness@0.3.0",
      commit_sha: "abc1234",
    },
  };
}

const BASE_POLICY: RolloutPolicyInput = {
  required_gates: ["audit-harness:ci:escape-scan"],
};

describe("decide — happy path", () => {
  it("allows when every required gate is present and passing", () => {
    const result = decide([makeStatement()], BASE_POLICY);
    expect(result.decision).toBe("allow");
    expect(result.reasons).toEqual([]);
    expect(result.evaluated.required_gates).toEqual([
      {
        pattern: "audit-harness:ci:escape-scan",
        status: "pass",
        matched_gate_ids: ["audit-harness:ci:escape-scan"],
      },
    ]);
    expect(result.evaluated.rows).toHaveLength(1);
    expect(result.evaluated.rows[0]).toMatchObject({
      index: 0,
      gate_id: "audit-harness:ci:escape-scan",
      gate_decision: "pass",
      valid: true,
      blocking: false,
    });
  });

  it("supports * wildcards in required-gate patterns", () => {
    const result = decide(
      [
        makeStatement({ gateId: "audit-harness:ci:escape-scan" }),
        makeStatement({ gateId: "audit-harness:ci:crap-score" }),
      ],
      { required_gates: ["audit-harness:ci:*"] },
    );
    expect(result.decision).toBe("allow");
    expect(result.evaluated.required_gates[0]?.matched_gate_ids).toEqual([
      "audit-harness:ci:escape-scan",
      "audit-harness:ci:crap-score",
    ]);
  });
});

describe("decide — fail closed", () => {
  it("blocks when a required gate is missing", () => {
    const result = decide([makeStatement({ gateId: "j-rig:ci:other-gate" })], BASE_POLICY);
    expect(result.decision).toBe("block");
    expect(result.reasons.some((r) => r.includes("required gate") && r.includes("missing"))).toBe(
      true,
    );
    expect(result.evaluated.required_gates[0]?.status).toBe("missing");
  });

  it("blocks when a required gate is present but not passing", () => {
    const result = decide([makeStatement({ decision: "advisory" })], {
      ...BASE_POLICY,
      // advisory does not block on its own here — the required gate must still PASS
      advisory_blocks: false,
    });
    expect(result.decision).toBe("block");
    expect(result.reasons.some((r) => r.includes("present but not passing"))).toBe(true);
    expect(result.evaluated.required_gates[0]?.status).toBe("not-passing");
  });

  it("blocks on a fail row (default forbid_decisions)", () => {
    const result = decide(
      [makeStatement(), makeStatement({ gateId: "j-rig:ci:other-gate", decision: "fail" })],
      BASE_POLICY,
    );
    expect(result.decision).toBe("block");
    expect(
      result.reasons.some((r) => r.includes("forbidden decision 'fail'") && r.includes("index 1")),
    ).toBe(true);
  });

  it("blocks on an error row (default forbid_decisions)", () => {
    const result = decide(
      [makeStatement(), makeStatement({ gateId: "j-rig:ci:other-gate", decision: "error" })],
      BASE_POLICY,
    );
    expect(result.decision).toBe("block");
    expect(result.reasons.some((r) => r.includes("forbidden decision 'error'"))).toBe(true);
  });

  it("blocks a schema-invalid row, citing the row index", () => {
    const bad = { not: "a statement" };
    const result = decide([makeStatement(), bad], BASE_POLICY);
    expect(result.decision).toBe("block");
    expect(result.reasons.some((r) => r.includes("schema-invalid row at index 1"))).toBe(true);
    expect(result.evaluated.rows[1]).toMatchObject({
      index: 1,
      gate_id: null,
      gate_decision: null,
      valid: false,
      blocking: true,
    });
  });

  it("blocks an empty bundle", () => {
    const result = decide([], BASE_POLICY);
    expect(result.decision).toBe("block");
    expect(result.reasons.some((r) => r.includes("empty bundle"))).toBe(true);
  });

  it("blocks a malformed bundle (not array, not container)", () => {
    for (const garbage of [null, undefined, "x", 42, { rows: [] }]) {
      const result = decide(garbage, BASE_POLICY);
      expect(result.decision).toBe("block");
      expect(result.reasons.some((r) => r.includes("malformed bundle"))).toBe(true);
    }
  });

  it("blocks a container with an unknown bundle_format", () => {
    const result = decide({ bundle_format: "tar", rows: [makeStatement()] }, BASE_POLICY);
    expect(result.decision).toBe("block");
    expect(result.reasons.some((r) => r.includes("unknown bundle_format"))).toBe(true);
  });

  it("blocks when the policy itself is garbage (fail closed, no throw)", () => {
    const result = decide([makeStatement()], { nope: true } as unknown as RolloutPolicyInput);
    expect(result.decision).toBe("block");
    expect(result.reasons.some((r) => r.includes("invalid policy"))).toBe(true);
  });
});

describe("decide — advisory handling", () => {
  const advisoryBundle = [
    makeStatement(),
    makeStatement({ gateId: "j-rig:ci:style-hints", decision: "advisory" }),
  ];

  it("allows a non-required advisory row by default", () => {
    const result = decide(advisoryBundle, BASE_POLICY);
    expect(result.decision).toBe("allow");
    expect(result.reasons).toEqual([]);
  });

  it("blocks the same advisory row when advisory_blocks=true", () => {
    const result = decide(advisoryBundle, { ...BASE_POLICY, advisory_blocks: true });
    expect(result.decision).toBe("block");
    expect(
      result.reasons.some((r) => r.includes("advisory decision") && r.includes("advisory_blocks")),
    ).toBe(true);
  });
});

describe("decide — unknown gates", () => {
  it("tolerates unknown gates by default", () => {
    const result = decide(
      [makeStatement(), makeStatement({ gateId: "j-rig:ci:extra-gate" })],
      BASE_POLICY,
    );
    expect(result.decision).toBe("allow");
  });

  it("blocks unknown gates when allow_unknown_gates=false", () => {
    const result = decide(
      [makeStatement(), makeStatement({ gateId: "j-rig:ci:extra-gate" })],
      { ...BASE_POLICY, allow_unknown_gates: false },
    );
    expect(result.decision).toBe("block");
    expect(
      result.reasons.some((r) => r.includes("unknown gate") && r.includes("j-rig:ci:extra-gate")),
    ).toBe(true);
  });
});

describe("decide — container vs plain-array parity", () => {
  it("produces identical results for both wire forms", () => {
    const rows = [
      makeStatement(),
      makeStatement({ gateId: "j-rig:ci:other-gate", decision: "fail" }),
    ];
    const plain = decide(rows, BASE_POLICY);
    const container = decide({ bundle_format: "json-array", rows }, BASE_POLICY);
    expect(container).toEqual(plain);
  });

  it("parity holds on the allow path too", () => {
    const rows = [makeStatement()];
    const plain = decide(rows, BASE_POLICY);
    const container = decide({ bundle_format: "json-array", rows }, BASE_POLICY);
    expect(plain.decision).toBe("allow");
    expect(container).toEqual(plain);
  });
});

describe("parseBundle", () => {
  it("classifies the plain-array form", () => {
    const parsed = parseBundle([makeStatement()]);
    expect(parsed.form).toBe("array");
    expect(parsed.formError).toBeNull();
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.statement).not.toBeNull();
  });

  it("classifies the legacy container form", () => {
    const parsed = parseBundle({ bundle_format: "json-array", rows: [makeStatement()] });
    expect(parsed.form).toBe("container");
    expect(parsed.rows).toHaveLength(1);
  });

  it("reports per-row errors with the row index", () => {
    const parsed = parseBundle([makeStatement(), { junk: 1 }]);
    expect(parsed.rows[1]).toMatchObject({ index: 1, statement: null });
    expect(parsed.rows[1]?.error).toBeTruthy();
  });

  it("flags non-array container rows as malformed", () => {
    const parsed = parseBundle({ bundle_format: "json-array", rows: "nope" });
    expect(parsed.form).toBe("malformed");
    expect(parsed.formError).toContain("rows must be an array");
  });
});
