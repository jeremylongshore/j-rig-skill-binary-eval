import { writeFileSync } from "node:fs";
import type { ObservedOutcome } from "@j-rig/core";

export interface RetainedRolloutRun {
  runId: number;
  model: string;
  provider: string;
  groundTruth: boolean;
  status: "completed" | "failed";
  outcomes: { id: string; prompt: string; output: string; status: string }[];
}

export function retainRolloutRun(
  metadata: Omit<RetainedRolloutRun, "outcomes">,
  outcomes: readonly ObservedOutcome[],
): RetainedRolloutRun {
  return {
    ...metadata,
    outcomes: outcomes.map((outcome) => ({
      id: outcome.test_case_id,
      prompt: outcome.prompt,
      output: outcome.output.text,
      status: outcome.output.error || outcome.meta.timed_out ? "failed" : outcome.status,
    })),
  };
}

/** Explicit opt-in transcript retention; never overwrite a prior evidence file. */
export function writeRolloutExport(
  path: string,
  input: {
    skillId: string;
    skillHash: string;
    spec: unknown;
    status: "completed" | "incomplete";
    runs: readonly RetainedRolloutRun[];
  },
): void {
  writeFileSync(path, JSON.stringify({ schema: "j-rig/rollouts/v1", ...input }, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
