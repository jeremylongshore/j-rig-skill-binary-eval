import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ObservedOutcome } from "@j-rig/core";
import { recordArtifact, type JRigDatabase } from "@j-rig/db";

/** Private local observations; the portable bundle carries only their digest/counts. */
export function storeToolExecutionEvidence(
  database: JRigDatabase,
  dbPath: string,
  runId: number,
  phase: "skill" | "baseline",
  configurationSha256: string,
  outcomes: ObservedOutcome[],
) {
  const receipt = {
    schema: "jrig-tool-execution/v1",
    run_id: runId,
    phase,
    configuration_sha256: configurationSha256,
    cases: outcomes.map(({ test_case_id, status, output, meta, provider_failure }) => ({
      test_case_id,
      status,
      output,
      meta,
      ...(provider_failure ? { provider_failure } : {}),
    })),
  };
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  // Fresh private directory and exclusive file avoid overwrites across runs or
  // concurrent CLI instances. No model-controlled value becomes a path.
  const directory = mkdtempSync(`${resolve(dbPath)}.execution-`);
  const filename = `${phase}.json`;
  const path = join(directory, filename);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  recordArtifact(database, runId, "tool-execution", filename, path, bytes.length, sha256);
  return {
    phase,
    sha256,
    cases: outcomes.length,
    completed_cases: outcomes.filter((outcome) => outcome.status === "completed").length,
    attempted_tool_calls: outcomes.reduce((sum, outcome) => sum + outcome.output.tool_calls, 0),
  };
}
