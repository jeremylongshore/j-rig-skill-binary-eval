import { describe, expect, it } from "vitest";
import { buildUnifiedReport, renderUnifiedReportMarkdown } from "./substrate.js";
import { renderUnifiedReportHtml } from "./html.js";

const selector = {
  grader_id: "answer-checker",
  grader_version: "1.0.0",
  grader_snapshot_sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

describe("unified report", () => {
  it("keeps cell metrics and raw lineage in a versioned report", () => {
    const report = buildUnifiedReport({
      generated_at: "2026-08-01T00:00:00.000Z",
      selector,
      observations: [
        {
          raw_run_id: "raw-0",
          task_id: "task-a",
          task_version: "1",
          config_id: "config-a",
          config_version: "1",
          model: "model-a",
          sample_index: 0,
          status: "completed",
          grade: { ...selector, verdict: "pass", score: 1 },
        },
        {
          raw_run_id: "raw-1",
          task_id: "task-a",
          task_version: "1",
          config_id: "config-a",
          config_version: "1",
          model: "model-a",
          sample_index: 1,
          status: "runner_error",
        },
      ],
    });

    expect(report.schema).toBe("j-rig/unified-report/v1");
    expect(report.summary).toMatchObject({
      cell_count: 1,
      attempted_runs: 2,
      completed_runs: 1,
      harness_failure_count: 1,
      graded_runs: 1,
      pass_count: 1,
    });
    expect(report.runs[1]?.grade).toBeNull();
  });

  it("renders a no-data-safe Markdown projection without an aggregate pass rate", () => {
    const report = buildUnifiedReport({
      generated_at: "2026-08-01T00:00:00.000Z",
      selector,
      observations: [],
    });
    const markdown = renderUnifiedReportMarkdown(report);
    expect(markdown).toContain("j-rig/unified-report/v1");
    expect(markdown).toContain("| no data |");
    expect(markdown).not.toContain("overall pass rate");
  });

  it("renders escaped, self-contained accessible HTML for a populated report", () => {
    const report = buildUnifiedReport({
      generated_at: "2026-08-01T00:00:00.000Z",
      selector,
      observations: [
        {
          raw_run_id: "raw-<script>",
          task_id: "task-a",
          task_version: "1",
          config_id: "config-a",
          config_version: "1",
          model: "model-<img>",
          sample_index: 0,
          status: "completed",
          grade: { ...selector, verdict: "pass", score: 1 },
        },
      ],
    });

    const html = renderUnifiedReportHtml(report, { title: "Suite <demo>" });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('lang="en"');
    expect(html).toContain('aria-labelledby="summary-heading"');
    expect(html).toContain("Suite &lt;demo&gt;");
    expect(html).toContain("raw-&lt;script&gt;");
    expect(html).toContain("model-&lt;img&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img>");
    expect(html).not.toContain("fetch(");
  });

  it("renders an explicit no-data state in HTML", () => {
    const report = buildUnifiedReport({
      generated_at: "2026-08-01T00:00:00.000Z",
      selector,
      observations: [],
    });

    const html = renderUnifiedReportHtml(report);

    expect(html).toContain("No cell measurements are available.");
    expect(html).toContain("No run data is available.");
  });
});
