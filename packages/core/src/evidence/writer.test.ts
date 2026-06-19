import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  composeStatement,
  writeBundle,
  serializeStatement,
  PREDICATE_URI,
  STATEMENT_TYPE,
} from "./index.js";

const SHA = "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";

/** v2 base input — all required fields per kernel gate-result/v1 shape. */
const baseInput = {
  gateId: "j-rig:server:MM-1",
  gateDecision: "pass" as const,
  gateName: "mm-1-async-race",
  gateVersion: "2.0.0",
  gateReasons: ["all criteria met"],
  coverage: { dimensionsEvaluated: ["async-race"], dimensionsSkipped: [] },
  policyRef: `sha256:${SHA}:vitest.config.ts`,
  policyHash: `sha256:${SHA}`,
  inputHash: `sha256:${SHA}`,
  runner: "j-rig@2.0.0",
  commitSha: "abc1234",
};

describe("composeStatement", () => {
  it("derives subject.name from gateId and digest from inputHash", () => {
    const stmt = composeStatement(baseInput);
    expect(stmt._type).toBe(STATEMENT_TYPE);
    expect(stmt.predicateType).toBe(PREDICATE_URI);
    expect(stmt.subject[0].name).toBe(baseInput.gateId);
    expect(stmt.subject[0].digest.sha256).toBe(SHA);
    expect(stmt.predicate.gate_id).toBe(baseInput.gateId);
    expect(stmt.predicate.input_hash).toBe(baseInput.inputHash);
  });

  it("sets evaluated_at when omitted (RFC 3339 with timezone offset)", () => {
    const stmt = composeStatement(baseInput);
    // RFC 3339 with offset: YYYY-MM-DDTHH:MM:SS+00:00 or ...Z
    expect(stmt.predicate.evaluated_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    );
  });

  it("preserves sub-second precision in evaluated_at (P1 lossless fix)", () => {
    // new Date().toISOString() includes milliseconds (.NNNz).
    // The writer must NOT strip them — Rfc3339Schema accepts the Z suffix
    // with fractional seconds, so no conversion is needed or correct.
    const stmt = composeStatement(baseInput);
    // Matches YYYY-MM-DDTHH:MM:SS.mmmZ — three-digit ms + Z suffix preserved
    expect(stmt.predicate.evaluated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it("preserves explicit evaluatedAt", () => {
    const ts = "2026-05-12T03:24:04Z";
    const stmt = composeStatement({ ...baseInput, evaluatedAt: ts });
    expect(stmt.predicate.evaluated_at).toBe(ts);
  });

  it("sets gate_name on predicate", () => {
    const stmt = composeStatement(baseInput);
    expect(stmt.predicate.gate_name).toBe("mm-1-async-race");
  });

  it("sets gate_version on predicate", () => {
    const stmt = composeStatement(baseInput);
    expect(stmt.predicate.gate_version).toBe("2.0.0");
  });

  it("sets gate_reasons on predicate", () => {
    const stmt = composeStatement(baseInput);
    expect(stmt.predicate.gate_reasons).toEqual(["all criteria met"]);
  });

  it("sets coverage on predicate", () => {
    const stmt = composeStatement({
      ...baseInput,
      coverage: { dimensionsEvaluated: ["lines", "branches"], dimensionsSkipped: ["functions"] },
    });
    expect(stmt.predicate.coverage).toEqual({
      dimensions_evaluated: ["lines", "branches"],
      dimensions_skipped: ["functions"],
    });
  });

  it("sets policy_ref on predicate", () => {
    const stmt = composeStatement(baseInput);
    expect(stmt.predicate.policy_ref).toBe(`sha256:${SHA}:vitest.config.ts`);
  });

  it("propagates metadata", () => {
    const stmt = composeStatement({ ...baseInput, metadata: { foo: "bar", n: 42 } });
    expect(stmt.predicate.metadata).toEqual({ foo: "bar", n: 42 });
  });

  it("includes failure_mode when gateDecision=fail", () => {
    const stmt = composeStatement({
      ...baseInput,
      gateDecision: "fail",
      failureMode: "MM-4",
    });
    expect(stmt.predicate.failure_mode).toBe("MM-4");
  });

  it("requires advisory_severity when gateDecision=advisory", () => {
    expect(() => composeStatement({ ...baseInput, gateDecision: "advisory" })).toThrow(
      /advisory_severity/,
    );
  });

  it("accepts advisory with severity", () => {
    const stmt = composeStatement({
      ...baseInput,
      gateDecision: "advisory",
      advisorySeverity: "warn",
    });
    expect(stmt.predicate.advisory_severity).toBe("warn");
  });

  it("throws on inputHash without sha256: prefix", () => {
    expect(() => composeStatement({ ...baseInput, inputHash: SHA })).toThrow(/sha256:-prefixed/);
  });

  it("throws on invalid gateId regex", () => {
    expect(() => composeStatement({ ...baseInput, gateId: "INVALID-Gate-Id" })).toThrow();
  });

  it("accepts error gate_decision", () => {
    const stmt = composeStatement({ ...baseInput, gateDecision: "error" });
    expect(stmt.predicate.gate_decision).toBe("error");
  });

  it("dimensions_skipped list is passed through to coverage", () => {
    const stmt = composeStatement({
      ...baseInput,
      coverage: {
        dimensionsEvaluated: [],
        dimensionsSkipped: ["not-applicable"],
      },
      // Use pass decision — not-applicable is expressed via skipped, not decision
      gateDecision: "pass",
    });
    expect(stmt.predicate.coverage.dimensions_skipped).toContain("not-applicable");
    expect(stmt.predicate.gate_decision).toBe("pass");
  });
});

describe("serializeStatement", () => {
  it("produces single-line JSON", () => {
    const stmt = composeStatement(baseInput);
    const s = serializeStatement(stmt);
    expect(s).not.toContain("\n");
    expect(JSON.parse(s)).toMatchObject({ _type: STATEMENT_TYPE });
  });
});

describe("writeBundle", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "j-rig-evidence-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const rows = [
    composeStatement({ ...baseInput, gateId: "j-rig:server:MM-1" }),
    composeStatement({ ...baseInput, gateId: "j-rig:server:MM-2" }),
    // NOT_APPLICABLE expressed as pass + dimensionsSkipped per DR-018 §279
    composeStatement({
      ...baseInput,
      gateId: "j-rig:server:MM-3",
      gateDecision: "pass",
      coverage: { dimensionsEvaluated: [], dimensionsSkipped: ["not-applicable"] },
    }),
  ];

  it("writes v2 plain JSON array form", () => {
    const out = join(tmpDir, "bundle.json");
    writeBundle(rows, { format: "array", outputPath: out });
    const parsed = JSON.parse(readFileSync(out, "utf-8"));
    // v2 array format: plain array, not { bundle_format: "json-array", rows: [...] }
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[2].predicate.coverage.dimensions_skipped).toContain("not-applicable");
  });

  it("writes JSONL form", () => {
    const out = join(tmpDir, "bundle.jsonl");
    writeBundle(rows, { format: "jsonl", outputPath: out });
    const lines = readFileSync(out, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    lines.forEach((line) => {
      const stmt = JSON.parse(line);
      expect(stmt._type).toBe(STATEMENT_TYPE);
    });
  });

  it("writes one-file-per-row form (json directory)", () => {
    writeBundle(rows, { format: "json", outputPath: tmpDir, perRowBasename: "stmt" });
    const files = readdirSync(tmpDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(files).toEqual(["stmt-0000.json", "stmt-0001.json", "stmt-0002.json"]);
  });
});
