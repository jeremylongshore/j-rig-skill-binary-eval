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

const baseInput = {
  gateId: "j-rig:server:MM-1",
  result: "PASS" as const,
  policyHash: `sha256:${SHA}`,
  inputHash: `sha256:${SHA}`,
  runner: "j-rig@0.15.0",
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

  it("sets timestamp when omitted", () => {
    const stmt = composeStatement(baseInput);
    expect(stmt.predicate.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("preserves explicit timestamp", () => {
    const ts = "2026-05-12T03:24:04Z";
    const stmt = composeStatement({ ...baseInput, timestamp: ts });
    expect(stmt.predicate.timestamp).toBe(ts);
  });

  it("propagates metadata", () => {
    const stmt = composeStatement({ ...baseInput, metadata: { foo: "bar", n: 42 } });
    expect(stmt.predicate.metadata).toEqual({ foo: "bar", n: 42 });
  });

  it("includes failure_mode when result=FAIL", () => {
    const stmt = composeStatement({
      ...baseInput,
      result: "FAIL",
      failureMode: "MM-4",
    });
    expect(stmt.predicate.failure_mode).toBe("MM-4");
  });

  it("requires advisory_severity when result=ADVISORY", () => {
    expect(() =>
      composeStatement({ ...baseInput, result: "ADVISORY" }),
    ).toThrow(/advisory_severity/);
  });

  it("accepts ADVISORY with severity", () => {
    const stmt = composeStatement({
      ...baseInput,
      result: "ADVISORY",
      advisorySeverity: "warn",
    });
    expect(stmt.predicate.advisory_severity).toBe("warn");
  });

  it("throws on inputHash without sha256: prefix", () => {
    expect(() =>
      composeStatement({ ...baseInput, inputHash: SHA }),
    ).toThrow(/sha256:-prefixed/);
  });

  it("throws on invalid gateId regex", () => {
    expect(() =>
      composeStatement({ ...baseInput, gateId: "INVALID-Gate-Id" }),
    ).toThrow();
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
    composeStatement({
      ...baseInput,
      gateId: "j-rig:server:MM-3",
      result: "NOT_APPLICABLE",
    }),
  ];

  it("writes JSON array container form", () => {
    const out = join(tmpDir, "bundle.json");
    writeBundle(rows, { format: "array", outputPath: out });
    const parsed = JSON.parse(readFileSync(out, "utf-8"));
    expect(parsed.bundle_format).toBe("json-array");
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[2].predicate.result).toBe("NOT_APPLICABLE");
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
    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(["stmt-0000.json", "stmt-0001.json", "stmt-0002.json"]);
  });
});
