import { describe, expect, it } from "vitest";
import { buildFromPipelineEnvelope } from "./emit-evidence.js";

const envelope = {
  gate_id: "test:gate",
  gate_decision: "pass",
  gate_name: "test-gate",
  gate_version: "2.0.0",
  gate_reasons: ["measured"],
  policy_ref: `sha256:${"a".repeat(64)}:policy.json`,
  policy_hash: `sha256:${"a".repeat(64)}`,
  input_hash: `sha256:${"b".repeat(64)}`,
};

function compose(value: Record<string, unknown>) {
  return buildFromPipelineEnvelope(value, "test-runner", "abc1234");
}

describe("pipeline evidence normalization", () => {
  it("preserves nested coverage and explicit provenance ahead of compatibility fields", () => {
    const metadata = { observed: true };
    const input = {
      ...envelope,
      result: "FAIL",
      coverage: { dimensions_evaluated: ["lines"], dimensions_skipped: ["mutation"] },
      coverage_evaluated: ["ignored-flat"],
      coverage_skipped: ["ignored-flat"],
      metadata,
    };
    const snapshot = structuredClone(input);
    expect(compose(input)).toEqual({
      gateId: envelope.gate_id,
      gateDecision: "pass",
      gateName: envelope.gate_name,
      gateVersion: envelope.gate_version,
      gateReasons: ["measured"],
      coverage: { dimensionsEvaluated: ["lines"], dimensionsSkipped: ["mutation"] },
      policyRef: envelope.policy_ref,
      policyHash: envelope.policy_hash,
      inputHash: envelope.input_hash,
      runner: "test-runner",
      commitSha: "abc1234",
      metadata,
      failureMode: undefined,
      advisorySeverity: undefined,
    });
    expect(input).toEqual(snapshot);
  });

  it("uses flat compatibility dimensions only when nested dimensions are not arrays", () => {
    expect(
      compose({
        ...envelope,
        coverage: { dimensions_evaluated: null, dimensions_skipped: "invalid" },
        coverage_evaluated: ["branches"],
        coverage_skipped: ["mutation"],
      }).coverage,
    ).toEqual({ dimensionsEvaluated: ["branches"], dimensionsSkipped: ["mutation"] });
    expect(compose({ ...envelope, coverage: "invalid" }).coverage).toEqual({
      dimensionsEvaluated: [],
      dimensionsSkipped: [],
    });
  });

  it("keeps explicit empty nested dimensions instead of falling back", () => {
    expect(
      compose({
        ...envelope,
        coverage: { dimensions_evaluated: [], dimensions_skipped: [] },
        coverage_evaluated: ["unused"],
        coverage_skipped: ["unused"],
      }).coverage,
    ).toEqual({ dimensionsEvaluated: [], dimensionsSkipped: [] });
  });

  it("maps the legacy decision without inventing provenance", () => {
    const legacy: Record<string, unknown> = { ...envelope };
    delete legacy.gate_decision;
    expect(compose({ ...legacy, result: "FAIL", failure_mode: "test-failure" })).toMatchObject({
      gateDecision: "fail",
      failureMode: "test-failure",
      gateReasons: ["measured"],
    });
  });

  it("retains the non-verdict sentinel before supplied skipped dimensions", () => {
    const result = compose({
      ...envelope,
      gate_decision: "NOT_APPLICABLE",
      coverage_skipped: ["mutation"],
    });
    expect(result.gateDecision).toBe("pass");
    expect(result.coverage.dimensionsSkipped).toEqual(["__not_applicable__", "mutation"]);
    expect(result.gateReasons).toEqual([
      "measured",
      "routed from NOT_APPLICABLE per DR-018 §279 — non-verdict, not a pass",
    ]);
  });

  it.each([
    "gate_id",
    "input_hash",
    "policy_hash",
    "gate_decision",
    "gate_name",
    "gate_version",
    "gate_reasons",
    "policy_ref",
  ])("refuses absent %s", (key) => {
    const input: Record<string, unknown> = { ...envelope };
    delete input[key];
    expect(() => compose(input)).toThrow(`missing required v2 field(s): ${key}.`);
  });

  it("reports missing provenance before attempting decision normalization", () => {
    expect(() => compose({ gate_decision: "invalid" })).toThrow(
      "missing required v2 field(s): gate_id, input_hash, policy_hash, gate_name, gate_version, gate_reasons, policy_ref.",
    );
  });

  it("validates advisory severity and preserves omitted or non-string optional values", () => {
    expect(compose({ ...envelope, advisory_severity: "warn" }).advisorySeverity).toBe("warn");
    expect(compose({ ...envelope, advisory_severity: 4 }).advisorySeverity).toBeUndefined();
    expect(() => compose({ ...envelope, advisory_severity: "unknown" })).toThrow(
      "invalid advisory_severity",
    );
  });
});
