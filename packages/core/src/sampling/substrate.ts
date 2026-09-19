import { z } from "zod";
import type { GradeMetadata, GradeVerdict, JudgeGradeMetadata } from "../grading/substrate.js";
import { EvalIdentifierSchema } from "../execution/substrate.js";

/** One homogeneous Task × Config × Model execution population. */
export const SamplingCellSchema = z.object({
  task_id: EvalIdentifierSchema,
  task_version: z.string().min(1),
  config_id: EvalIdentifierSchema,
  config_version: z.string().min(1),
  model: z.string().min(1),
});

export type SamplingCell = z.infer<typeof SamplingCellSchema>;

export const SampleObservationStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "runner_error",
  "timed_out",
]);

export type SampleObservationStatus = z.infer<typeof SampleObservationStatusSchema>;

export const SampleObservationSchema = SamplingCellSchema.extend({
  sample_index: z.number().int().nonnegative(),
  status: SampleObservationStatusSchema,
});

export type SampleObservation = z.infer<typeof SampleObservationSchema>;

export interface SampleJob extends SamplingCell {
  pass_index: number;
  sample_index: number;
}

export interface SamplingCellSummary extends SamplingCell {
  attempted_count: number;
  completed_count: number;
  active_count: number;
  harness_failure_count: number;
  planned_count: number;
  projected_count: number;
}

export interface BalancedSamplingPlan {
  target_n: number;
  cells: SamplingCellSummary[];
  jobs: SampleJob[];
}

export interface BalancedSamplingInput {
  cells: SamplingCell[];
  existing_runs: SampleObservation[];
  target_n: number;
}

/** Stable grouping key; every population dimension remains explicit. */
export function samplingCellKey(cell: SamplingCell): string {
  return [cell.task_id, cell.task_version, cell.config_id, cell.config_version, cell.model]
    .map((part) => JSON.stringify(part))
    .join("\u0000");
}

function validateSamplingInput(input: BalancedSamplingInput): void {
  if (!Number.isInteger(input.target_n) || input.target_n < 1) {
    throw new Error(`target_n must be a positive integer (got ${input.target_n})`);
  }

  const keys = new Set<string>();
  for (const cell of input.cells) {
    const parsed = SamplingCellSchema.safeParse(cell);
    if (!parsed.success) throw new Error(`Invalid sampling cell: ${parsed.error.message}`);
    const key = samplingCellKey(cell);
    if (keys.has(key)) throw new Error(`Duplicate sampling cell: ${key}`);
    keys.add(key);
  }

  for (const run of input.existing_runs) {
    const parsed = SampleObservationSchema.safeParse(run);
    if (!parsed.success) throw new Error(`Invalid sample observation: ${parsed.error.message}`);
  }
}

/**
 * Build a resumable, balanced top-up plan for complete Task × Config × Model
 * executions. Completed Runs count toward target N; pending/running Runs
 * reserve a slot; runner errors and timeouts remain visible but are replaced by
 * a fresh sample index on the next available pass.
 */
export function planBalancedSamples(input: BalancedSamplingInput): BalancedSamplingPlan {
  validateSamplingInput(input);

  const requested = new Set(input.cells.map(samplingCellKey));
  const state = new Map<
    string,
    {
      cell: SamplingCell;
      runs: SampleObservation[];
      next_sample_index: number;
      planned_count: number;
    }
  >();

  for (const cell of input.cells) {
    state.set(samplingCellKey(cell), {
      cell,
      runs: [],
      next_sample_index: 0,
      planned_count: 0,
    });
  }

  for (const run of input.existing_runs) {
    const key = samplingCellKey(run);
    if (!requested.has(key)) continue;
    const entry = state.get(key);
    if (!entry) continue;
    entry.runs.push(run);
    entry.next_sample_index = Math.max(entry.next_sample_index, run.sample_index + 1);
  }

  const jobs: SampleJob[] = [];
  for (let passIndex = 0; passIndex < input.target_n; passIndex += 1) {
    for (const cell of input.cells) {
      const entry = state.get(samplingCellKey(cell));
      if (!entry) continue;
      const completed = entry.runs.filter((run) => run.status === "completed").length;
      const active = entry.runs.filter(
        (run) => run.status === "pending" || run.status === "running",
      ).length;
      const projected = completed + active + entry.planned_count;
      if (projected >= input.target_n) continue;

      jobs.push({
        ...cell,
        pass_index: projected,
        sample_index: entry.next_sample_index,
      });
      entry.next_sample_index += 1;
      entry.planned_count += 1;
    }
  }

  const summaries = input.cells.map((cell): SamplingCellSummary => {
    const entry = state.get(samplingCellKey(cell));
    if (!entry) throw new Error(`Missing sampling state for ${samplingCellKey(cell)}`);
    const completed_count = entry.runs.filter((run) => run.status === "completed").length;
    const active_count = entry.runs.filter(
      (run) => run.status === "pending" || run.status === "running",
    ).length;
    const harness_failure_count = entry.runs.filter(
      (run) => run.status === "runner_error" || run.status === "timed_out",
    ).length;
    return {
      ...cell,
      attempted_count: entry.runs.length,
      completed_count,
      active_count,
      harness_failure_count,
      planned_count: entry.planned_count,
      projected_count: completed_count + active_count + entry.planned_count,
    };
  });

  return { target_n: input.target_n, cells: summaries, jobs };
}

export interface GradeSelector {
  grader_id: string;
  grader_version: string;
  grader_snapshot_sha256: string;
}

export const GradeSelectorSchema = z.object({
  grader_id: z.string().min(1),
  grader_version: z.string().min(1),
  grader_snapshot_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export interface SamplingGrade {
  grader_id: string;
  grader_version: string;
  grader_snapshot_sha256: string;
  verdict: GradeVerdict;
  score: number;
  metadata?: GradeMetadata;
}

export interface GradeObservation extends SampleObservation {
  raw_run_id: string;
  grade?: SamplingGrade;
}

export interface WilsonInterval {
  lower: number;
  upper: number;
  confidence_level: 0.95;
}

export interface GradeMeasurement extends SamplingCell {
  grader_id: string;
  grader_version: string;
  grader_snapshot_sha256: string;
  attempted_runs: number;
  completed_runs: number;
  active_runs: number;
  harness_failure_count: number;
  graded_runs: number;
  ungraded_completed_runs: number;
  pass_count: number;
  fail_count: number;
  pass_rate: number | null;
  standard_error: number | null;
  confidence_interval_95: WilsonInterval | null;
  mean_score: number | null;
  score_standard_error: number | null;
  judge_sampled_runs: number;
  judge_vote_count: number;
  judge_disagreement_count: number;
  judge_disagreement_rate: number | null;
  judge_agreement_mean: number | null;
}

/** Wilson score interval for a binary pass rate at the fixed 95% level. */
export function wilsonInterval(successes: number, trials: number): WilsonInterval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) {
    throw new Error("Wilson interval counts must be integers");
  }
  if (trials < 0 || successes < 0 || successes > trials) {
    throw new Error(`Invalid Wilson interval counts: ${successes}/${trials}`);
  }
  if (trials === 0) return null;

  const z = 1.959963984540054;
  const proportion = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (proportion + (z * z) / (2 * trials)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / trials + (z * z) / (4 * trials * trials));
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    confidence_level: 0.95,
  };
}

function standardError(values: number[]): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

/**
 * Summarize one explicitly selected Grader snapshot without mixing task,
 * config, model, or predicate dimensions. Missing Grades remain ungraded;
 * harness failures remain separate from quality failures.
 */
export function summarizeGradeObservations(
  observations: GradeObservation[],
  selector: GradeSelector,
): GradeMeasurement[] {
  const groups = new Map<string, GradeObservation[]>();
  for (const observation of observations) {
    if (observation.grade) {
      const matches =
        observation.grade.grader_id === selector.grader_id &&
        observation.grade.grader_version === selector.grader_version &&
        observation.grade.grader_snapshot_sha256 === selector.grader_snapshot_sha256;
      if (!matches) {
        throw new Error(
          `Grade ${observation.raw_run_id} does not match selected ${selector.grader_id}@${selector.grader_version}`,
        );
      }
    }
    const key = samplingCellKey(observation);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, rows]) => {
    const first = rows[0];
    if (!first) throw new Error(`Empty measurement group ${key}`);
    const completed = rows.filter((row) => row.status === "completed");
    const graded = completed.filter((row) => row.grade !== undefined);
    const pass_count = graded.filter((row) => row.grade?.verdict === "pass").length;
    const fail_count = graded.filter((row) => row.grade?.verdict === "fail").length;
    const scores = graded
      .map((row) => row.grade?.score)
      .filter((score): score is number => score !== undefined);
    const judgeMetadata = graded
      .map((row) => row.grade?.metadata?.judge)
      .filter((judge): judge is JudgeGradeMetadata => judge !== undefined);
    const judge_vote_count = judgeMetadata.reduce((sum, judge) => sum + judge.samples, 0);
    const judge_disagreement_count = judgeMetadata.filter((judge) => judge.disagreement).length;
    const pass_rate = graded.length === 0 ? null : pass_count / graded.length;
    return {
      task_id: first.task_id,
      task_version: first.task_version,
      config_id: first.config_id,
      config_version: first.config_version,
      model: first.model,
      grader_id: selector.grader_id,
      grader_version: selector.grader_version,
      grader_snapshot_sha256: selector.grader_snapshot_sha256,
      attempted_runs: rows.length,
      completed_runs: completed.length,
      active_runs: rows.filter((row) => row.status === "pending" || row.status === "running")
        .length,
      harness_failure_count: rows.filter(
        (row) => row.status === "runner_error" || row.status === "timed_out",
      ).length,
      graded_runs: graded.length,
      ungraded_completed_runs: completed.length - graded.length,
      pass_count,
      fail_count,
      pass_rate,
      standard_error:
        pass_rate === null ? null : Math.sqrt((pass_rate * (1 - pass_rate)) / graded.length),
      confidence_interval_95: wilsonInterval(pass_count, graded.length),
      mean_score:
        scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
      score_standard_error: standardError(scores),
      judge_sampled_runs: judgeMetadata.length,
      judge_vote_count,
      judge_disagreement_count,
      judge_disagreement_rate:
        judgeMetadata.length === 0 ? null : judge_disagreement_count / judgeMetadata.length,
      judge_agreement_mean:
        judgeMetadata.length === 0
          ? null
          : judgeMetadata.reduce((sum, judge) => sum + judge.agreement, 0) / judgeMetadata.length,
    };
  });
}
