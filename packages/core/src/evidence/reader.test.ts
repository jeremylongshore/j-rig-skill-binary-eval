import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readBundle, composeStatement, writeBundle } from "./index.js";

const SHA = "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";

/** v2 base composeStatement input — all required kernel gate-result/v1 fields. */
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

const goodRow = composeStatement(baseInput);

describe("readBundle", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "j-rig-evidence-read-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a single-Statement .json file", () => {
    const path = join(tmpDir, "row.json");
    writeFileSync(path, JSON.stringify(goodRow));
    const result = readBundle(path);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].predicate.gate_id).toBe("j-rig:server:MM-1");
  });

  it("reads a v2 plain JSON array form", () => {
    const path = join(tmpDir, "bundle.json");
    writeBundle([goodRow, goodRow], { format: "array", outputPath: path });
    const result = readBundle(path);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });

  it("reads a v1 legacy container { bundle_format: 'json-array', rows: [...] }", () => {
    const path = join(tmpDir, "legacy-bundle.json");
    writeFileSync(path, JSON.stringify({ bundle_format: "json-array", rows: [goodRow, goodRow] }));
    const result = readBundle(path);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });

  it("reads a JSONL bundle", () => {
    const path = join(tmpDir, "bundle.jsonl");
    writeBundle([goodRow, goodRow, goodRow], { format: "jsonl", outputPath: path });
    const result = readBundle(path);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(3);
  });

  it("reads a directory of per-row .json files", () => {
    writeBundle([goodRow, goodRow], {
      format: "json",
      outputPath: tmpDir,
      perRowBasename: "row",
    });
    const result = readBundle(tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });

  it("preserves valid rows when one row in JSONL is malformed (R2 row independence)", () => {
    const path = join(tmpDir, "mixed.jsonl");
    writeFileSync(
      path,
      JSON.stringify(goodRow) + "\n{ this is not valid json }\n" + JSON.stringify(goodRow) + "\n",
    );
    const result = readBundle(path);
    expect(result.rows).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/parse error/);
  });

  it("preserves valid rows when one row in v2 array is invalid (R2)", () => {
    const path = join(tmpDir, "mixed.json");
    const badRow = JSON.parse(JSON.stringify(goodRow));
    badRow.subject[0].name = "j-rig:server:wrong-name"; // breaks R8 / I1 invariant
    writeFileSync(path, JSON.stringify([goodRow, badRow, goodRow]));
    const result = readBundle(path);
    expect(result.rows).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
  });

  it("preserves valid rows when one row in v1 legacy container is invalid (R2)", () => {
    const path = join(tmpDir, "mixed-legacy.json");
    const badRow = JSON.parse(JSON.stringify(goodRow));
    badRow.subject[0].name = "j-rig:server:wrong-name"; // breaks invariant
    const container = { bundle_format: "json-array", rows: [goodRow, badRow, goodRow] };
    writeFileSync(path, JSON.stringify(container));
    const result = readBundle(path);
    expect(result.rows).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
  });

  it("returns parse error on top-level malformed file", () => {
    const path = join(tmpDir, "broken.json");
    writeFileSync(path, "{not json");
    const result = readBundle(path);
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/parse error/);
  });

  it("returns empty result for empty JSONL file", () => {
    const path = join(tmpDir, "empty.jsonl");
    writeFileSync(path, "");
    const result = readBundle(path);
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // ── P2 — v1 legacy container with v1-BODIED row is rejected (reader claim fix) ──
  //
  // The reader docs claim to handle "v1 legacy containers". This is accurate only
  // for the WRAPPER form `{ bundle_format: "json-array", rows: [...] }`. The ROW
  // BODIES must still conform to the v2 (gate-result/v1) predicate schema. A
  // genuine v1 predicate body (using `result`/`timestamp` instead of
  // `gate_decision`/`evaluated_at`) will be rejected as a row-level validation
  // error. This test documents and proves that behaviour.
  it("v1 legacy container wrapper accepted but v1-BODIED row rejected as row error (P2 reader claim fix)", () => {
    const path = join(tmpDir, "v1-body-in-container.json");
    // A v1-shaped predicate body: uses `result` + `timestamp` (old fields),
    // lacks gate_name/gate_version/gate_reasons/coverage/policy_ref (new required).
    const v1BodyRow = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "j-rig:server:MM-1", digest: { sha256: SHA } }],
      predicateType: "https://evals.intentsolutions.io/gate-result/v1",
      predicate: {
        gate_id: "j-rig:server:MM-1",
        result: "PASS",              // v1 field — not valid in v2 schema
        policy_hash: `sha256:${SHA}`,
        input_hash: `sha256:${SHA}`,
        timestamp: "2026-01-01T00:00:00Z",  // v1 field — not valid in v2 schema
        runner: "j-rig@1.0.0",
        commit_sha: "abc1234",
      },
    };
    const container = { bundle_format: "json-array", rows: [v1BodyRow] };
    writeFileSync(path, JSON.stringify(container));
    const result = readBundle(path);
    // The wrapper is understood; the row body is rejected as malformed
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    // Error should reference the predicate body fields
    expect(result.errors[0].message).toBeTruthy();
  });

  it("v1 legacy container with a valid v2-bodied row succeeds", () => {
    // Only the CONTAINER FORM is legacy; the row body must still be v2-shaped.
    const path = join(tmpDir, "v2-body-in-v1-container.json");
    const container = { bundle_format: "json-array", rows: [goodRow, goodRow] };
    writeFileSync(path, JSON.stringify(container));
    const result = readBundle(path);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });
});
