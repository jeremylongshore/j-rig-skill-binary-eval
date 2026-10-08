import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeMetrics, type TriggerResult } from "@j-rig/core";
import { recordArtifact, type JRigDatabase } from "@j-rig/db";

/** Keep routing prompts/reasoning private; retain re-computable decisions in portable evidence. */
export function storeTriggerEvidence(
  database: JRigDatabase,
  dbPath: string,
  runId: number,
  enabled: boolean,
  results: TriggerResult[],
) {
  const status = !enabled
    ? "skipped"
    : results.length === 0
      ? "not_applicable"
      : results.some((result) => result.outcome === "error")
        ? "incomplete"
        : "complete";
  const metrics = computeMetrics(results);
  const receipt = { schema: "jrig-trigger-evidence/v1", run_id: runId, status, results, metrics };
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  const directory = mkdtempSync(`${resolve(dbPath)}.trigger-`);
  const filename = "trigger.json";
  const path = join(directory, filename);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  recordArtifact(database, runId, "trigger-evidence", filename, path, bytes.length, sha256);
  return {
    schema: receipt.schema,
    status,
    sha256,
    metrics,
    cases: results.map(({ test_case_id, expected, outcome, selected_skill }) => ({
      test_case_id,
      expected,
      outcome,
      selected_skill,
    })),
  };
}
