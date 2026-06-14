import { describe, it, expect } from "vitest";
import {
  migrateBundle,
  migrateStatement,
  deriveGateName,
  deriveGateVersion,
  derivePolicyRef,
  NOT_APPLICABLE_TOKEN,
  NOT_APPLICABLE_REASON,
} from "./transform.js";

function v1Statement(result: string, overrides: Record<string, unknown> = {}): unknown {
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
      ...overrides,
    },
  };
}

function pred(stmt: unknown): Record<string, unknown> {
  return (stmt as { predicate: Record<string, unknown> }).predicate;
}

describe("migrateStatement — v1 → v2 field mapping", () => {
  it("renames result → gate_decision (PASS → pass)", () => {
    const { value, report } = migrateStatement(v1Statement("PASS"), 0);
    expect(report.outcome).toBe("migrated");
    const p = pred(value);
    expect(p.gate_decision).toBe("pass");
    expect("result" in p).toBe(false);
  });

  it("maps FAIL → fail and ADVISORY → advisory", () => {
    expect(pred(migrateStatement(v1Statement("FAIL"), 0).value).gate_decision).toBe("fail");
    expect(pred(migrateStatement(v1Statement("ADVISORY"), 0).value).gate_decision).toBe("advisory");
  });

  it("renames timestamp → evaluated_at (value unchanged)", () => {
    const p = pred(migrateStatement(v1Statement("PASS"), 0).value);
    expect(p.evaluated_at).toBe("2026-06-13T00:00:00.000Z");
    expect("timestamp" in p).toBe(false);
  });

  it("adds the 5 new required fields", () => {
    const p = pred(migrateStatement(v1Statement("PASS"), 0).value);
    expect(p.gate_name).toBe("mm-1");
    expect(p.gate_version).toBe("2.0.0");
    expect(p.gate_reasons).toEqual([]);
    expect(p.coverage).toEqual({ dimensions_evaluated: [], dimensions_skipped: [] });
    expect(p.policy_ref).toBe(`sha256:${"c".repeat(64)}:unknown`);
  });

  it("preserves unchanged fields", () => {
    const p = pred(migrateStatement(v1Statement("PASS"), 0).value);
    expect(p.policy_hash).toBe(`sha256:${"c".repeat(64)}`);
    expect(p.input_hash).toBe(`sha256:${"a".repeat(64)}`);
    expect(p.runner).toBe("j-rig@2.0.0");
    expect(p.commit_sha).toBe("abc1234");
  });

  it("preserves optional passthrough fields", () => {
    // advisory_severity is a valid Evidence Bundle enum (info / warn / error);
    // any value proves the passthrough. "error" is used here.
    const stmt = v1Statement("ADVISORY", {
      metadata: { note: "x" },
      failure_mode: "fm",
      advisory_severity: "error",
    });
    const p = pred(migrateStatement(stmt, 0).value);
    expect(p.metadata).toEqual({ note: "x" });
    expect(p.failure_mode).toBe("fm");
    expect(p.advisory_severity).toBe("error");
  });
});

describe("migrateStatement — NOT_APPLICABLE routing (DR-018 §279)", () => {
  it("routes NOT_APPLICABLE to a non-verdict pass + skipped token + reason", () => {
    const { value, report } = migrateStatement(v1Statement("NOT_APPLICABLE"), 0);
    expect(report.outcome).toBe("migrated");
    expect(report.note).toContain("routed NOT_APPLICABLE");
    const p = pred(value);
    expect(p.gate_decision).toBe("pass");
    expect((p.coverage as { dimensions_skipped: string[] }).dimensions_skipped).toContain(
      NOT_APPLICABLE_TOKEN,
    );
    expect(p.gate_reasons).toContain(NOT_APPLICABLE_REASON);
  });

  it("appends the routing reason to existing gate_reasons", () => {
    const stmt = v1Statement("NOT_APPLICABLE", { gate_reasons: ["pre-existing"] });
    const p = pred(migrateStatement(stmt, 0).value);
    expect(p.gate_reasons).toEqual(["pre-existing", NOT_APPLICABLE_REASON]);
  });
});

describe("migrateStatement — passthrough & errors", () => {
  it("leaves an already-v2 row untouched", () => {
    const v2 = {
      _type: "x",
      subject: [],
      predicateType: "x",
      predicate: { gate_id: "j-rig:ci:MM-1", gate_decision: "pass" },
    };
    const { value, report } = migrateStatement(v2, 0);
    expect(report.outcome).toBe("already-v2");
    expect(value).toBe(v2);
  });

  it("reports a non-statement as not-a-statement", () => {
    expect(migrateStatement(42, 0).report.outcome).toBe("not-a-statement");
    expect(migrateStatement({ no: "predicate" }, 0).report.outcome).toBe("not-a-statement");
  });

  it("errors when a predicate has neither result nor gate_decision", () => {
    const r = migrateStatement({ predicate: { gate_id: "j-rig:ci:MM-1" } }, 0);
    expect(r.report.outcome).toBe("error");
    expect(r.report.note).toContain("cannot migrate");
  });

  it("errors on an unknown v1 result value", () => {
    const r = migrateStatement(v1Statement("MAYBE"), 0);
    expect(r.report.outcome).toBe("error");
    expect(r.report.note).toContain("unknown v1 result value");
  });

  it("errors when result is not a string", () => {
    const r = migrateStatement(v1Statement("PASS", { result: 1 }), 0);
    expect(r.report.outcome).toBe("error");
    expect(r.report.note).toContain("must be a string");
  });

  it("captures gate_id in the report even on error", () => {
    const r = migrateStatement(v1Statement("MAYBE"), 3);
    expect(r.report.gateId).toBe("j-rig:ci:MM-1");
    expect(r.report.index).toBe(3);
  });
});

describe("migrateBundle — container shapes", () => {
  it("migrates a plain array of statements", () => {
    const res = migrateBundle([v1Statement("PASS"), v1Statement("FAIL")]);
    expect(res.changed).toBe(true);
    expect(res.rows.map((r) => r.outcome)).toEqual(["migrated", "migrated"]);
    expect(Array.isArray(res.migrated)).toBe(true);
  });

  it("migrates a { bundle_format, rows } container and keeps the wrapper", () => {
    const input = { bundle_format: "json-array", rows: [v1Statement("PASS")] };
    const res = migrateBundle(input);
    expect(res.changed).toBe(true);
    const out = res.migrated as { bundle_format: string; rows: unknown[] };
    expect(out.bundle_format).toBe("json-array");
    expect(pred(out.rows[0]).gate_decision).toBe("pass");
  });

  it("migrates a single statement object", () => {
    const res = migrateBundle(v1Statement("PASS"));
    expect(res.changed).toBe(true);
    expect(res.rows).toHaveLength(1);
  });

  it("reports changed=false for an already-v2 bundle", () => {
    const v2 = {
      _type: "x",
      subject: [],
      predicateType: "x",
      predicate: { gate_id: "g", gate_decision: "pass" },
    };
    const res = migrateBundle([v2]);
    expect(res.changed).toBe(false);
    expect(res.rows[0].outcome).toBe("already-v2");
  });

  it("migrates only the v1 rows in a mixed bundle", () => {
    const v2 = {
      _type: "x",
      subject: [],
      predicateType: "x",
      predicate: { gate_id: "g", gate_decision: "pass" },
    };
    const res = migrateBundle([v1Statement("PASS"), v2]);
    expect(res.changed).toBe(true);
    expect(res.rows.map((r) => r.outcome)).toEqual(["migrated", "already-v2"]);
  });
});

describe("derivation helpers", () => {
  it("deriveGateName extracts the 3rd segment lowercased", () => {
    expect(deriveGateName("j-rig:ci:MM-1")).toBe("mm-1");
    expect(deriveGateName("tool:server:CamelCase")).toBe("camel-case");
  });

  it("deriveGateName falls back for malformed ids", () => {
    expect(deriveGateName("noColons")).toBe("migrated-gate");
    expect(deriveGateName("")).toBe("migrated-gate");
    expect(deriveGateName("a:b:")).toBe("migrated-gate");
  });

  it("deriveGateVersion parses the runner @semver", () => {
    expect(deriveGateVersion("j-rig@2.0.0")).toBe("2.0.0");
    expect(deriveGateVersion("tool@1.2.3-rc.1")).toBe("1.2.3-rc.1");
  });

  it("deriveGateVersion falls back to 0.0.0", () => {
    expect(deriveGateVersion("")).toBe("0.0.0");
    expect(deriveGateVersion("j-rig")).toBe("0.0.0");
  });

  it("derivePolicyRef uses the policy_hash when valid", () => {
    expect(derivePolicyRef(`sha256:${"c".repeat(64)}`)).toBe(`sha256:${"c".repeat(64)}:unknown`);
  });

  it("derivePolicyRef falls back when policy_hash is missing/invalid", () => {
    expect(derivePolicyRef(undefined)).toBe(`sha256:${"0".repeat(64)}:unknown`);
    expect(derivePolicyRef("nope")).toBe(`sha256:${"0".repeat(64)}:unknown`);
  });
});
