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

describe("unified report headroom (000-docs/043)", () => {
  function observations(verdicts: Array<"pass" | "fail">) {
    return verdicts.map((verdict, i) => ({
      raw_run_id: `raw-${i}`,
      task_id: "task-a",
      task_version: "1",
      config_id: "config-a",
      config_version: "1",
      model: "model-a",
      sample_index: i,
      status: "completed" as const,
      grade: { ...selector, verdict, score: verdict === "pass" ? 1 : 0 },
    }));
  }
  const at = "2026-10-04T00:00:00.000Z";

  it("marks a cell that passes every graded run as saturated", () => {
    const report = buildUnifiedReport({
      generated_at: at,
      selector,
      observations: observations(Array(10).fill("pass")),
    });
    expect(report.cells[0]?.headroom_status).toBe("saturated");
  });

  it("distinguishes near_ceiling from headroom per cell, never rolled up", () => {
    const near = buildUnifiedReport({
      generated_at: at,
      selector,
      observations: observations([...Array(9).fill("pass"), "fail"]),
    });
    const room = buildUnifiedReport({
      generated_at: at,
      selector,
      observations: observations([...Array(5).fill("pass"), ...Array(5).fill("fail")]),
    });
    expect(near.cells[0]?.headroom_status).toBe("near_ceiling");
    expect(room.cells[0]?.headroom_status).toBe("headroom");
    expect(Object.keys(near.summary)).not.toContain("headroom_status");
  });

  it("reports no_data for a cell with no graded runs", () => {
    const report = buildUnifiedReport({
      generated_at: at,
      selector,
      observations: [
        { ...observations(["pass"])[0]!, status: "runner_error" as const, grade: undefined },
      ],
    });
    expect(report.cells[0]?.headroom_status).toBe("no_data");
  });

  it("renders a Headroom column in Markdown and HTML", () => {
    const report = buildUnifiedReport({
      generated_at: at,
      selector,
      observations: observations(Array(10).fill("pass")),
    });
    const md = renderUnifiedReportMarkdown(report);
    expect(md).toContain("| 95% Wilson | Headroom |");
    expect(md).toContain("| saturated |");
    const html = renderUnifiedReportHtml(report);
    expect(html).toContain('<th scope="col">Headroom</th>');
    expect(html).toContain("<td>saturated</td>");
  });

  it("renders a dash for a report built before headroom_status existed", () => {
    const report = buildUnifiedReport({
      generated_at: at,
      selector,
      observations: observations(["pass", "fail"]),
    });
    const legacy = {
      ...report,
      cells: report.cells.map((cell) => {
        const copy = { ...cell };
        delete copy.headroom_status;
        return copy;
      }),
    };
    expect(renderUnifiedReportMarkdown(legacy)).toMatch(/\| \[[0-9.]+, [0-9.]+\] \| — \|/);
  });
});
