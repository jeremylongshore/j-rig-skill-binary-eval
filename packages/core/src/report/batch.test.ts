import { describe, expect, it } from "vitest";
import {
  buildEvalBatchReport,
  renderEvalBatchReportHtml,
  renderEvalBatchReportMarkdown,
} from "./batch.js";

function reportInput() {
  return {
    batch_id: "batch-<demo>",
    skills_root: "/tmp/skills/<root>",
    provider: "deepseek",
    models: "deepseek-v4-flash",
    database: "/tmp/evidence.db",
    manifest_path: "/tmp/batch/manifest.json",
    generated_at: "2026-08-02T00:00:00.000Z",
    completed_at: "2026-08-02T00:00:01.000Z",
    summary: { discovered: 1, completed: 1, failed: 0 },
    entries: [
      {
        skill_dir: "/tmp/skills/<script>",
        skill_relative_path: "<script>",
        skill_name: "skill-<img>",
        spec_path: "/tmp/batch/specs/<script>.yaml",
        spec_source: "generated" as const,
        bundle_path: "/tmp/batch/bundles/<script>.json",
        result_path: "/tmp/batch/results/<script>.json",
        status: "completed" as const,
        exit_code: 0,
        signal: null,
        duration_ms: 12,
        models: [
          {
            model: "deepseek-<model>",
            provider: "deepseek",
            decision: "warn",
            ground_truth: true,
          },
        ],
        diagnostics: "diagnostic <b>text</b>",
      },
    ],
  };
}

describe("eval-batch report", () => {
  it("renders escaped lineage and static accessible HTML", () => {
    const report = buildEvalBatchReport(reportInput());
    const html = renderEvalBatchReportHtml(report);
    const markdown = renderEvalBatchReportMarkdown(report);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('lang="en"');
    expect(html).toContain('aria-labelledby="entries-heading"');
    expect(html).toContain("batch-&lt;demo&gt;");
    expect(html).toContain("skill-&lt;img&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img>");
    expect(html).not.toContain("fetch(");
    expect(markdown).toContain("ground_truth=true");
    expect(markdown).toContain("does not");
    expect(markdown).toContain("&lt;script&gt;");
  });

  it("renders explicit no-data states without a quality rollup", () => {
    const report = buildEvalBatchReport({
      ...reportInput(),
      summary: { discovered: 0, completed: 0, failed: 0 },
      entries: [],
    });
    const html = renderEvalBatchReportHtml(report);
    const markdown = renderEvalBatchReportMarkdown(report);

    expect(html).toContain("No batch entries are available.");
    expect(markdown).toContain("No batch entries are available.");
    expect(markdown).not.toContain("| Pass rate |");
  });
});
