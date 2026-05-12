import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readBundle, composeStatement, writeBundle } from "./index.js";

const SHA = "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";

const goodRow = composeStatement({
  gateId: "j-rig:server:MM-1",
  result: "PASS",
  policyHash: `sha256:${SHA}`,
  inputHash: `sha256:${SHA}`,
  runner: "j-rig@0.15.0",
  commitSha: "abc1234",
});

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

  it("reads a JSON array container", () => {
    const path = join(tmpDir, "bundle.json");
    writeBundle([goodRow, goodRow], { format: "array", outputPath: path });
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

  it("preserves valid rows when one row in array container is invalid (R2)", () => {
    const path = join(tmpDir, "mixed.json");
    const badRow = JSON.parse(JSON.stringify(goodRow));
    badRow.subject[0].name = "j-rig:server:wrong-name"; // breaks R8 invariant
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
});
