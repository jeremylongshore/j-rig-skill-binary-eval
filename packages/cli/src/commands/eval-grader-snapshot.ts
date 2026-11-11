import type { Criterion } from "@j-rig/core";
import type { SkillEvalSpec } from "../lib/loaders.js";
interface GraderSnapshotInput {
  executionMetadata: Record<string, unknown>;
  toolConfig?: { fingerprint: string; runtime: { judgeObservations?: unknown } };
  scoringCriteria: Criterion[];
  providers: { judgeProviderName: string; judgeModelId: string };
  judgeSamples?: number;
  spec: Pick<
    SkillEvalSpec,
    "judge_temperature" | "judge_timeout_ms" | "judge_sample_concurrency" | "min_blocker_agreement"
  >;
}
/** Preserve grader snapshot fields and insertion order used by its canonical digest. */
export function buildGraderSnapshot(input: GraderSnapshotInput) {
  const { executionMetadata, toolConfig, scoringCriteria, providers, judgeSamples, spec } = input;
  return {
    schema: "j-rig/binary-criteria-grader/v1",
    ...executionMetadata,
    ...(toolConfig?.runtime.judgeObservations
      ? {
          tool_observations: "jrig-tool-observations/v1",
          mcp_configuration_sha256: toolConfig.fingerprint,
        }
      : {}),
    criteria: scoringCriteria,
    judge: {
      provider: providers.judgeProviderName,
      model: providers.judgeModelId,
      samples: judgeSamples ?? 1,
      temperature: spec.judge_temperature ?? 0,
      timeout_ms: spec.judge_timeout_ms ?? 120000,
      sample_concurrency: spec.judge_sample_concurrency ?? judgeSamples ?? 1,
    },
    stability: {
      min_blocker_agreement: spec.min_blocker_agreement ?? null,
    },
  };
}
