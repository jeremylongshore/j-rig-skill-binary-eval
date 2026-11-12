import { CostAdmissionError } from "@intentsolutions/refiner";
import { judgeCriteria, ProviderError, type JudgeProvider, type JudgmentResult } from "@j-rig/core";
import type { AdmittedReplay } from "./judge-replay-input.js";

export interface ReplayObservation {
  row_id: string;
  repeat: number;
  expected_verdict: "yes" | "no";
  result: JudgmentResult;
  provider_invocations: number;
  admission_refused_samples: number;
  failed_samples: number;
  sample_observations: Array<{
    sample: number;
    status: "completed" | "failed" | "admission_refused";
    provider_invoked: boolean;
    verdict?: "yes" | "no" | "unsure";
  }>;
}

/** One backend, fixed retained outputs, no execution leg and no label generation. */
export async function replayJudgments(
  input: AdmittedReplay,
  provider: JudgeProvider,
  beforeSample: () => void,
  now: () => number = () => performance.now(),
) {
  const started = now();
  const observations: ReplayObservation[] = [];
  let stopped = false;
  for (let repeat = 0; repeat < input.policy.repeats && !stopped; repeat++) {
    for (const row of input.rows) {
      let attempted = 0;
      let failed = 0;
      let refused = 0;
      const sampleObservations: ReplayObservation["sample_observations"] = [];
      const bounded: JudgeProvider = {
        async judge(...args) {
          let invoked = false;
          try {
            beforeSample();
            attempted++;
            invoked = true;
            const result = await provider.judge(...args);
            sampleObservations.push({
              sample: sampleObservations.length,
              status: "completed",
              provider_invoked: true,
              verdict: result.verdict,
            });
            return result;
          } catch (error) {
            const admission =
              !invoked ||
              error instanceof CostAdmissionError ||
              (error instanceof ProviderError && error.originalError instanceof CostAdmissionError);
            if (admission) refused++;
            else failed++;
            sampleObservations.push({
              sample: sampleObservations.length,
              status: admission ? "admission_refused" : "failed",
              provider_invoked: invoked,
            });
            throw error;
          }
        },
      };
      try {
        beforeSample();
      } catch {
        stopped = true;
        break;
      }
      const admittedAt = new Date().toISOString();
      const [result] = await judgeCriteria(
        [row.criterion],
        {
          test_case_id: row.id,
          prompt: row.golden.prompt,
          output: { text: row.golden.output, artifacts: [], tool_calls: 0 },
          status: "completed",
          // These timestamps describe replay admission, not original output generation.
          meta: {
            started_at: admittedAt,
            completed_at: admittedAt,
            duration_ms: 0,
            timed_out: false,
          },
        },
        bounded,
        {
          model: input.policy.model,
          samples: input.policy.samples,
          judgeTemperature: input.policy.temperature,
          judgeTimeoutMs: input.policy.judge_timeout_ms,
          sampleConcurrency: 1,
        },
      );
      observations.push({
        row_id: row.id,
        repeat,
        expected_verdict: row.golden.expected_verdict,
        result: result!,
        provider_invocations: attempted,
        admission_refused_samples: refused,
        failed_samples: failed,
        sample_observations: sampleObservations,
      });
    }
  }
  const fullySampled = (row: ReplayObservation) =>
    !row.result.judge_error &&
    row.failed_samples === 0 &&
    row.admission_refused_samples === 0 &&
    row.provider_invocations === input.policy.samples;
  const repeatGroups = input.rows.map((row) =>
    observations.filter((item) => item.row_id === row.id),
  );
  const comparableGroups = repeatGroups.filter(
    (group) => group.length === input.policy.repeats && group.every(fullySampled),
  );
  const repeatDisagreements = comparableGroups.filter(
    (group) => new Set(group.map((row) => row.result.verdict)).size > 1,
  ).length;
  const planned = input.rows.length * input.policy.repeats;
  const completed = observations.filter(fullySampled);
  const judged = observations.filter((row) => !row.result.judge_error);
  const correct = judged.filter((row) => row.result.verdict === row.expected_verdict).length;
  const unsure = judged.filter((row) => row.result.verdict === "unsure").length;
  return {
    schema: "j-rig/judge-replay-report/v1" as const,
    status:
      stopped || completed.length !== planned ? ("incomplete" as const) : ("completed" as const),
    corpus_sha256: input.corpusHash,
    review_sha256: input.reviewHash,
    policy_sha256: input.policyHash,
    policy: input.policy,
    pacing: input.pacing,
    elapsed_ms: now() - started,
    planned_cells: planned,
    completed_cells: completed.length,
    judged_cells: judged.length,
    degraded_cells: observations.length - completed.length,
    unstarted_cells: planned - observations.length,
    provider_invocations: observations.reduce((sum, row) => sum + row.provider_invocations, 0),
    admission_refused_samples: observations.reduce(
      (sum, row) => sum + row.admission_refused_samples,
      0,
    ),
    correct,
    unsure,
    repeat_stability: {
      comparable_rows: input.policy.repeats > 1 ? comparableGroups.length : 0,
      rows_with_disagreement: input.policy.repeats > 1 ? repeatDisagreements : 0,
      measured: input.policy.repeats > 1,
    },
    // Planned denominator prevents aborted/failed cells improving accuracy.
    accuracy: correct / planned,
    failed_samples: observations.reduce((sum, row) => sum + row.failed_samples, 0),
    observations,
  };
}
