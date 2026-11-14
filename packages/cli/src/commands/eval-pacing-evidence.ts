import { createHash } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordArtifact, transitionRun, type JRigDatabase } from "@j-rig/db";
import type { RequestPacingPolicy } from "../providers/request-pacing.js";

/** Publish a private, hash-bound policy receipt before this run can dispatch. */
export function retainRequestPacing(
  database: JRigDatabase,
  dbPath: string,
  runId: number,
  policy: RequestPacingPolicy,
  judge: { judgeProviderName: string; judgeModelId: string },
): void {
  let directory: string | undefined;
  try {
    const receipt = {
      schema: "j-rig/request-pacing-receipt/v1",
      run_id: runId,
      policy,
      judge: { provider: judge.judgeProviderName, model: judge.judgeModelId },
    };
    const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
    const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    directory = mkdtempSync(`${resolve(dbPath)}.pacing-`);
    const filename = "request-pacing.json";
    const temporary = join(directory, "pending.json");
    const destination = join(directory, filename);
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
    recordArtifact(database, runId, "request-pacing", filename, destination, bytes.length, sha256);
  } catch {
    // A crash may leave an unlinked private directory, never a successful run.
    // Remove only the unique directory created by this operation on caught failure.
    try {
      if (directory) rmSync(directory, { recursive: true, force: true });
    } finally {
      transitionRun(database, runId, "failed", JSON.stringify({ type: "pacing_receipt_failed" }));
    }
    throw new Error("Unable to retain request pacing policy; evaluation refused");
  }
}
