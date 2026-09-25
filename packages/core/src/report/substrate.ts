import { z } from "zod";
import {
  GradeSelectorSchema,
  summarizeGradeObservations,
  type GradeMeasurement,
  type GradeObservation,
  type GradeSelector,
  type SamplingGrade,
} from "../sampling/substrate.js";

const GradeMeasurementSchema = z.object({
  task_id: z.string().min(1),
  task_version: z.string().min(1),
  config_id: z.string().min(1),
  config_version: z.string().min(1),
  model: z.string().min(1),
  grader_id: z.string().min(1),
  grader_version: z.string().min(1),
  grader_snapshot_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  attempted_runs: z.number().int().nonnegative(),
  completed_runs: z.number().int().nonnegative(),
  active_runs: z.number().int().nonnegative(),
  harness_failure_count: z.number().int().nonnegative(),
  graded_runs: z.number().int().nonnegative(),
  ungraded_completed_runs: z.number().int().nonnegative(),
  pass_count: z.number().int().nonnegative(),
  fail_count: z.number().int().nonnegative(),
  pass_rate: z.number().min(0).max(1).nullable(),
  standard_error: z.number().nonnegative().nullable(),
  confidence_interval_95: z
    .object({
      lower: z.number().min(0).max(1),
      upper: z.number().min(0).max(1),
      confidence_level: z.literal(0.95),
    })
    .nullable(),
  mean_score: z.number().nullable(),
  score_standard_error: z.number().nonnegative().nullable(),
});

const SamplingGradeSchema = z.object({
  grader_id: z.string().min(1),
  grader_version: z.string().min(1),
  grader_snapshot_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  verdict: z.enum(["pass", "fail"]),
  score: z.number(),
});

const UnifiedReportRunSchema = z.object({
  raw_run_id: z.string().min(1),
  task_id: z.string().min(1),
  task_version: z.string().min(1),
  config_id: z.string().min(1),
  config_version: z.string().min(1),
  model: z.string().min(1),
  sample_index: z.number().int().nonnegative(),
  status: z.enum(["pending", "running", "completed", "runner_error", "timed_out"]),
  grade: SamplingGradeSchema.nullable(),
});

export const UnifiedReportSchema = z.object({
  schema: z.literal("j-rig/unified-report/v1"),
  generated_at: z.string().min(1),
  grader: GradeSelectorSchema,
  summary: z.object({
    cell_count: z.number().int().nonnegative(),
    attempted_runs: z.number().int().nonnegative(),
    completed_runs: z.number().int().nonnegative(),
    active_runs: z.number().int().nonnegative(),
    harness_failure_count: z.number().int().nonnegative(),
    graded_runs: z.number().int().nonnegative(),
    ungraded_completed_runs: z.number().int().nonnegative(),
    pass_count: z.number().int().nonnegative(),
    fail_count: z.number().int().nonnegative(),
  }),
  cells: z.array(GradeMeasurementSchema),
  runs: z.array(UnifiedReportRunSchema),
});

export type UnifiedReport = z.infer<typeof UnifiedReportSchema>;

export interface UnifiedReportInput {
  observations: GradeObservation[];
  selector: GradeSelector;
  generated_at: string;
}

function measurementSummary(measurements: GradeMeasurement[]) {
  return measurements.reduce(
    (summary, measurement) => ({
      cell_count: summary.cell_count + 1,
      attempted_runs: summary.attempted_runs + measurement.attempted_runs,
      completed_runs: summary.completed_runs + measurement.completed_runs,
      active_runs: summary.active_runs + measurement.active_runs,
      harness_failure_count: summary.harness_failure_count + measurement.harness_failure_count,
      graded_runs: summary.graded_runs + measurement.graded_runs,
      ungraded_completed_runs:
        summary.ungraded_completed_runs + measurement.ungraded_completed_runs,
      pass_count: summary.pass_count + measurement.pass_count,
      fail_count: summary.fail_count + measurement.fail_count,
    }),
    {
      cell_count: 0,
      attempted_runs: 0,
      completed_runs: 0,
      active_runs: 0,
      harness_failure_count: 0,
      graded_runs: 0,
      ungraded_completed_runs: 0,
      pass_count: 0,
      fail_count: 0,
    },
  );
}

/** Build a versioned report while preserving cell-level, non-rolled-up metrics. */
export function buildUnifiedReport(input: UnifiedReportInput): UnifiedReport {
  const measurements = summarizeGradeObservations(input.observations, input.selector);
  const report: UnifiedReport = {
    schema: "j-rig/unified-report/v1",
    generated_at: input.generated_at,
    grader: input.selector,
    summary: measurementSummary(measurements),
    cells: measurements,
    runs: input.observations.map((observation) => ({
      raw_run_id: observation.raw_run_id,
      task_id: observation.task_id,
      task_version: observation.task_version,
      config_id: observation.config_id,
      config_version: observation.config_version,
      model: observation.model,
      sample_index: observation.sample_index,
      status: observation.status,
      grade: observation.grade ?? null,
    })),
  };
  return UnifiedReportSchema.parse(report);
}

function markdownCell(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function interval(measurement: GradeMeasurement): string {
  const confidence = measurement.confidence_interval_95;
  return confidence ? `[${confidence.lower.toFixed(3)}, ${confidence.upper.toFixed(3)}]` : "—";
}

/** Render the same report data as terminal-friendly Markdown. */
export function renderUnifiedReportMarkdown(report: UnifiedReport): string {
  const lines = [
    "# J-Rig Unified Evaluation Report",
    "",
    `- Schema: \`${report.schema}\``,
    `- Generated: ${report.generated_at}`,
    `- Grader: \`${report.grader.grader_id}@${report.grader.grader_version}\``,
    `- Snapshot: \`${report.grader.grader_snapshot_sha256}\``,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    ...Object.entries(report.summary).map(([key, value]) => `| ${key} | ${value} |`),
    "",
    "## Cells",
    "",
    "| Task | Config | Model | Completed | Graded | Pass rate | 95% Wilson | Harness failures | Ungraded | Mean score | Score SE |",
    "|---|---|---|---:|---:|---:|---|---:|---:|---:|---:|",
  ];

  for (const rawCell of report.cells) {
    const cell = rawCell as unknown as GradeMeasurement;
    lines.push(
      `| ${markdownCell(`${cell.task_id}@${cell.task_version}`)} | ${markdownCell(`${cell.config_id}@${cell.config_version}`)} | ${markdownCell(cell.model)} | ${cell.completed_runs} | ${cell.graded_runs} | ${cell.pass_rate === null ? "—" : cell.pass_rate.toFixed(3)} | ${interval(cell)} | ${cell.harness_failure_count} | ${cell.ungraded_completed_runs} | ${cell.mean_score === null ? "—" : cell.mean_score.toFixed(3)} | ${cell.score_standard_error === null ? "—" : cell.score_standard_error.toFixed(3)} |`,
    );
  }
  if (report.cells.length === 0) lines.push("| — | — | — | 0 | 0 | — | — | 0 | 0 | — | — |");

  lines.push(
    "",
    "## Runs",
    "",
    "| Raw Run | Task | Config | Model | Sample | Status | Verdict |",
    "|---|---|---|---|---:|---|---|",
  );
  for (const run of report.runs) {
    const grade = run.grade as SamplingGrade | null;
    lines.push(
      `| \`${markdownCell(run.raw_run_id)}\` | ${markdownCell(`${run.task_id}@${run.task_version}`)} | ${markdownCell(`${run.config_id}@${run.config_version}`)} | ${markdownCell(run.model)} | ${run.sample_index} | ${run.status} | ${grade?.verdict ?? "ungraded"} |`,
    );
  }
  if (report.runs.length === 0) lines.push("| — | — | — | — | — | no data | — |");
  return `${lines.join("\n")}\n`;
}
