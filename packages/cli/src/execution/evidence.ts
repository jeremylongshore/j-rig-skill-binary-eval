import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ObservedOutcome, ReasoningEffort } from "@j-rig/core";
import { recordArtifact, type JRigDatabase } from "@j-rig/db";

const Observation = z
  .object({
    schema: z.literal("jrig-tool-observations/v1"),
    session_id: z.string().uuid(),
    redaction: z.literal("known-environment-credentials-and-credential-fields/v1"),
    calls: z
      .array(
        z
          .object({
            id: z.string().min(1),
            tool: z.string().min(1),
            arguments: z.record(z.string(), z.unknown()),
            status: z.literal("completed"),
            result: z.string(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

/** Only runtime-owned artifacts from this completed outcome may reach its judges. */
export function getJudgeObservations(
  outcome: ObservedOutcome,
  enabled: boolean,
  maxBytes: number,
): string | undefined {
  if (!enabled || outcome.status !== "completed") return undefined;
  const records = outcome.output.artifacts.filter(
    (record) => record.filename === "tool-observations.json",
  );
  const identities = outcome.output.artifacts.filter(
    (record) => record.filename === "tool-session.json",
  );
  if (records.length !== 1 || identities.length !== 1)
    throw new Error("tool observation identity missing");
  const record = records[0]!;
  if (
    record.type !== "text" ||
    Buffer.byteLength(record.content) !== record.size_bytes ||
    record.size_bytes > maxBytes
  )
    throw new Error("tool observation size invalid");
  const data = Observation.parse(JSON.parse(record.content));
  const identity = JSON.parse(identities[0]!.content);
  if (
    identity.schema !== "jrig-tool-session/v1" ||
    identity.session_id !== data.session_id ||
    data.calls.length !== outcome.output.tool_calls ||
    new Set(data.calls.map((call) => call.id)).size !== data.calls.length
  )
    throw new Error("tool observation session mismatch");
  return record.content;
}

/** Private local observations; the portable bundle carries only their digest/counts. */
export function storeToolExecutionEvidence(
  database: JRigDatabase,
  dbPath: string,
  runId: number,
  phase: "skill" | "baseline",
  configurationSha256: string,
  outcomes: ObservedOutcome[],
  observationsEnabled = false,
  maxObservationBytes = 4194304,
  executionParameters?: { reasoning_effort: ReasoningEffort },
) {
  const judgeContexts = observationsEnabled
    ? outcomes.flatMap((outcome) => {
        const content = getJudgeObservations(outcome, true, maxObservationBytes);
        if (content === undefined) return [];
        return [
          {
            test_case_id: outcome.test_case_id,
            session_id: JSON.parse(content).session_id,
            sha256: "sha256:" + createHash("sha256").update(content).digest("hex"),
            size_bytes: Buffer.byteLength(content),
          },
        ];
      })
    : undefined;
  const receipt = {
    schema: "jrig-tool-execution/v1",
    run_id: runId,
    phase,
    ...(executionParameters ? { execution_parameters: executionParameters } : {}),
    configuration_sha256: configurationSha256,
    ...(judgeContexts ? { judge_contexts: judgeContexts } : {}),
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
    ...(executionParameters ? { execution_parameters: executionParameters } : {}),
    sha256,
    ...(judgeContexts ? { judge_contexts: judgeContexts } : {}),
    cases: outcomes.length,
    completed_cases: outcomes.filter((outcome) => outcome.status === "completed").length,
    attempted_tool_calls: outcomes.reduce((sum, outcome) => sum + outcome.output.tool_calls, 0),
  };
}
