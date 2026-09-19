import { describe, expect, it } from "vitest";
import {
  planBalancedSamples,
  summarizeGradeObservations,
  wilsonInterval,
  type SamplingCell,
} from "./substrate.js";

const cells: SamplingCell[] = [
  {
    task_id: "task-a",
    task_version: "1",
    config_id: "config-a",
    config_version: "1",
    model: "model-a",
  },
  {
    task_id: "task-b",
    task_version: "1",
    config_id: "config-a",
    config_version: "1",
    model: "model-a",
  },
];

describe("balanced execution sampling", () => {
  it("plans round-robin sample passes for every cell", () => {
    const plan = planBalancedSamples({ cells, existing_runs: [], target_n: 2 });

    expect(plan.jobs.map((job) => [job.task_id, job.sample_index])).toEqual([
      ["task-a", 0],
      ["task-b", 0],
      ["task-a", 1],
      ["task-b", 1],
    ]);
    expect(plan.cells.map((cell) => cell.planned_count)).toEqual([2, 2]);
  });

  it("tops up completed runs, reserves active runs, and replaces failures", () => {
    const plan = planBalancedSamples({
      cells,
      target_n: 2,
      existing_runs: [
        { ...cells[0]!, sample_index: 0, status: "runner_error" },
        { ...cells[0]!, sample_index: 1, status: "completed" },
        { ...cells[1]!, sample_index: 0, status: "running" },
      ],
    });

    expect(plan.jobs).toEqual([
      { ...cells[0]!, pass_index: 1, sample_index: 2 },
      { ...cells[1]!, pass_index: 1, sample_index: 1 },
    ]);
    expect(plan.cells[0]).toMatchObject({
      completed_count: 1,
      active_count: 0,
      harness_failure_count: 1,
      planned_count: 1,
      projected_count: 2,
    });
    expect(plan.cells[1]).toMatchObject({
      completed_count: 0,
      active_count: 1,
      planned_count: 1,
      projected_count: 2,
    });
  });

  it("rejects duplicate cells and invalid targets", () => {
    expect(() =>
      planBalancedSamples({ cells: [cells[0]!, cells[0]!], existing_runs: [], target_n: 1 }),
    ).toThrow("Duplicate sampling cell");
    expect(() => planBalancedSamples({ cells, existing_runs: [], target_n: 0 })).toThrow(
      "positive integer",
    );
  });
});

describe("binary grade uncertainty", () => {
  const selector = {
    grader_id: "answer-checker",
    grader_version: "1.0.0",
    grader_snapshot_sha256: "sha256:abc",
  };

  it("computes a bounded Wilson interval", () => {
    const interval = wilsonInterval(2, 4);
    expect(interval?.confidence_level).toBe(0.95);
    expect(interval?.lower).toBeCloseTo(0.15, 2);
    expect(interval?.upper).toBeCloseTo(0.85, 2);
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it("keeps failures, ungraded completions, and grader results distinct", () => {
    const measurements = summarizeGradeObservations(
      [
        {
          ...cells[0]!,
          raw_run_id: "raw-0",
          sample_index: 0,
          status: "completed",
          grade: {
            ...selector,
            verdict: "pass",
            score: 1,
            metadata: {
              judge: {
                judge_model: "fixture-judge",
                raw_verdict: "yes",
                samples: 3,
                agreement: 2 / 3,
                sample_verdicts: ["yes", "no", "yes"],
                disagreement: true,
                reasoning: "fixture",
              },
            },
          },
        },
        { ...cells[0]!, raw_run_id: "raw-1", sample_index: 1, status: "completed" },
        { ...cells[0]!, raw_run_id: "raw-2", sample_index: 2, status: "runner_error" },
        {
          ...cells[1]!,
          raw_run_id: "raw-3",
          sample_index: 0,
          status: "completed",
          grade: { ...selector, verdict: "fail", score: 0 },
        },
      ],
      selector,
    );

    expect(measurements).toHaveLength(2);
    expect(measurements[0]).toMatchObject({
      task_id: "task-a",
      attempted_runs: 3,
      completed_runs: 2,
      harness_failure_count: 1,
      graded_runs: 1,
      ungraded_completed_runs: 1,
      pass_count: 1,
      fail_count: 0,
      pass_rate: 1,
      mean_score: 1,
      judge_sampled_runs: 1,
      judge_vote_count: 3,
      judge_disagreement_count: 1,
      judge_disagreement_rate: 1,
      judge_agreement_mean: 2 / 3,
    });
    expect(measurements[1]).toMatchObject({
      task_id: "task-b",
      graded_runs: 1,
      pass_count: 0,
      fail_count: 1,
      pass_rate: 0,
      mean_score: 0,
      judge_sampled_runs: 0,
      judge_vote_count: 0,
      judge_disagreement_count: 0,
      judge_disagreement_rate: null,
      judge_agreement_mean: null,
    });
  });

  it("refuses to mix a different grader snapshot", () => {
    expect(() =>
      summarizeGradeObservations(
        [
          {
            ...cells[0]!,
            raw_run_id: "raw-0",
            sample_index: 0,
            status: "completed",
            grade: {
              ...selector,
              grader_snapshot_sha256: "sha256:different",
              verdict: "pass",
              score: 1,
            },
          },
        ],
        selector,
      ),
    ).toThrow("does not match selected");
  });
});
