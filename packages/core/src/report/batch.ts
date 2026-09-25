import { z } from "zod";
import { escapeHtml } from "./html.js";

const BatchReportModelSchema = z.object({
  model: z.string(),
  provider: z.string().optional(),
  decision: z.string().optional(),
  ground_truth: z.boolean().optional(),
});

const BatchReportEntrySchema = z.object({
  skill_dir: z.string(),
  skill_relative_path: z.string(),
  skill_name: z.string(),
  spec_path: z.string(),
  spec_source: z.enum(["existing", "generated"]),
  bundle_path: z.string(),
  result_path: z.string(),
  status: z.enum(["completed", "failed"]),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  duration_ms: z.number().int().nonnegative(),
  models: z.array(BatchReportModelSchema),
  diagnostics: z.string().optional(),
  error: z.string().optional(),
});

const BatchReportSummarySchema = z.object({
  discovered: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const EvalBatchReportSchema = z.object({
  schema: z.literal("j-rig/eval-batch-report/v1"),
  batch_id: z.string(),
  skills_root: z.string(),
  provider: z.string(),
  models: z.string().nullable(),
  database: z.string(),
  manifest_path: z.string(),
  generated_at: z.string(),
  completed_at: z.string(),
  summary: BatchReportSummarySchema,
  entries: z.array(BatchReportEntrySchema),
});

export type EvalBatchReportModel = z.infer<typeof BatchReportModelSchema>;
export type EvalBatchReportEntry = z.infer<typeof BatchReportEntrySchema>;
export type EvalBatchReport = z.infer<typeof EvalBatchReportSchema>;

export type EvalBatchReportInput = Omit<EvalBatchReport, "schema">;

/** Build and validate a versioned, lineage-preserving batch report. */
export function buildEvalBatchReport(input: EvalBatchReportInput): EvalBatchReport {
  return EvalBatchReportSchema.parse({
    schema: "j-rig/eval-batch-report/v1",
    ...input,
  });
}

function markdownCell(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function modelSummary(entry: EvalBatchReportEntry): string {
  if (entry.models.length === 0) return "—";
  return entry.models
    .map((model) => {
      const metadata = [
        model.provider,
        model.decision,
        model.ground_truth === undefined ? undefined : `ground_truth=${model.ground_truth}`,
      ]
        .filter((value): value is string => value !== undefined)
        .join(", ");
      return metadata ? `${model.model} (${metadata})` : model.model;
    })
    .join("; ");
}

/** Render batch lineage and status without inventing an aggregate quality score. */
export function renderEvalBatchReportMarkdown(report: EvalBatchReport): string {
  const lines = [
    "# J-Rig Eval Batch Report",
    "",
    `- Schema: \`${report.schema}\``,
    `- Batch: \`${markdownCell(report.batch_id)}\``,
    `- Skills root: \`${markdownCell(report.skills_root)}\``,
    `- Provider: \`${markdownCell(report.provider)}\``,
    `- Models: \`${markdownCell(report.models ?? "auto")}\``,
    `- Manifest: \`${markdownCell(report.manifest_path)}\``,
    "",
    "## Batch status",
    "",
    "This report preserves per-skill lineage and execution status. It does not",
    "invent an overall pass rate or rollout decision across heterogeneous skills.",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Discovered | ${report.summary.discovered} |`,
    `| Completed | ${report.summary.completed} |`,
    `| Failed | ${report.summary.failed} |`,
    "",
    "## Entries",
    "",
    "| Skill | Spec | Status | Models / provider metadata | Result | Bundle | Diagnostics |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const entry of report.entries) {
    lines.push(
      `| ${markdownCell(`${entry.skill_name} (${entry.skill_relative_path})`)} | ${markdownCell(`${entry.spec_source}: ${entry.spec_path}`)} | ${entry.status} | ${markdownCell(modelSummary(entry))} | ${markdownCell(entry.result_path)} | ${markdownCell(entry.bundle_path)} | ${markdownCell(entry.error ?? entry.diagnostics ?? "—")} |`,
    );
  }
  if (report.entries.length === 0) {
    lines.push("| — | — | no data | — | — | — | No batch entries are available. |");
  }

  return `${lines.join("\n")}\n`;
}

function htmlModelSummary(entry: EvalBatchReportEntry): string {
  return modelSummary(entry);
}

/** Render a self-contained, accessible static batch report. */
export function renderEvalBatchReportHtml(report: EvalBatchReport): string {
  const css = `
    :root { color-scheme: light dark; --bg: #0b1020; --panel: #131b2e; --ink: #eef3ff; --muted: #a7b3ca; --line: #2b3a59; --accent: #8dd7ff; --focus: #ffd166; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1600px; margin: 0 auto; padding: 2rem clamp(1rem, 3vw, 3rem) 4rem; }
    .skip-link { position: absolute; left: 1rem; top: -4rem; background: var(--focus); color: #111; padding: .5rem .75rem; z-index: 2; }
    .skip-link:focus { top: 1rem; }
    header { border-bottom: 1px solid var(--line); margin-bottom: 2rem; padding-bottom: 1.5rem; }
    .eyebrow { color: var(--accent); font: 700 .75rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
    h1, h2 { line-height: 1.15; }
    h1 { font-size: clamp(1.8rem, 4vw, 3rem); margin: .35rem 0 .75rem; }
    h2 { font-size: 1.35rem; margin: 2.2rem 0 .8rem; }
    .meta { color: var(--muted); margin: .25rem 0; overflow-wrap: anywhere; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin: 0; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: .6rem; padding: .8rem 1rem; }
    .metric dt { color: var(--muted); font-size: .8rem; text-transform: capitalize; }
    .metric dd { font-size: 1.35rem; font-weight: 700; margin: .2rem 0 0; }
    .table-wrap { border: 1px solid var(--line); border-radius: .6rem; overflow-x: auto; background: var(--panel); }
    table { border-collapse: collapse; min-width: 1100px; width: 100%; }
    caption { color: var(--muted); font-size: .9rem; padding: .8rem 1rem; text-align: left; }
    th, td { border-top: 1px solid var(--line); padding: .65rem .75rem; text-align: left; vertical-align: top; }
    thead th { background: var(--panel); border-top: 0; color: var(--ink); font-size: .8rem; position: sticky; top: 0; white-space: nowrap; }
    tbody th { font-weight: 650; }
    .status { border: 1px solid var(--line); border-radius: 999px; display: inline-block; font: 700 .75rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; padding: .2rem .45rem; }
    .failed { border-color: #ff8f8f; color: #ffb3b3; }
    .empty { color: var(--muted); padding: 1.2rem; text-align: center; }
    code { color: var(--accent); font: .85em ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
    @media print { :root { color-scheme: light; --bg: #fff; --panel: #fff; --ink: #111; --muted: #555; --line: #bbb; } .table-wrap { overflow: visible; } table { min-width: 0; } thead th { position: static; } }
  `;
  const summaryRows = [
    ["Discovered", report.summary.discovered],
    ["Completed", report.summary.completed],
    ["Failed", report.summary.failed],
  ]
    .map(
      ([label, value]) =>
        `<div class="metric"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`,
    )
    .join("");
  const entryRows = report.entries
    .map((entry) => {
      const statusClass = entry.status === "failed" ? "status failed" : "status";
      return (
        `<tr><th scope="row">${escapeHtml(entry.skill_name)}<br><code>${escapeHtml(entry.skill_relative_path)}</code></th>` +
        `<td>${escapeHtml(`${entry.spec_source}: ${entry.spec_path}`)}</td>` +
        `<td><span class="${statusClass}">${escapeHtml(entry.status)}</span></td>` +
        `<td>${escapeHtml(htmlModelSummary(entry))}</td>` +
        `<td><code>${escapeHtml(entry.result_path)}</code></td>` +
        `<td><code>${escapeHtml(entry.bundle_path)}</code></td>` +
        `<td>${escapeHtml(entry.error ?? entry.diagnostics ?? "—")}</td></tr>`
      );
    })
    .join("");
  const entryBody =
    entryRows || '<tr><td class="empty" colspan="7">No batch entries are available.</td></tr>';

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    "  <title>J-Rig Eval Batch Report</title>",
    `  <style>${css}</style>`,
    "</head>",
    "<body>",
    '  <a class="skip-link" href="#batch-report-main">Skip to batch report</a>',
    '  <main id="batch-report-main">',
    "    <header>",
    `      <p class="eyebrow">${escapeHtml(report.schema)}</p>`,
    "      <h1>J-Rig Eval Batch Report</h1>",
    `      <p class="meta">Batch: <code>${escapeHtml(report.batch_id)}</code></p>`,
    `      <p class="meta">Skills root: <code>${escapeHtml(report.skills_root)}</code></p>`,
    `      <p class="meta">Provider: <code>${escapeHtml(report.provider)}</code> · Models: <code>${escapeHtml(report.models ?? "auto")}</code></p>`,
    `      <p class="meta">Manifest: <code>${escapeHtml(report.manifest_path)}</code></p>`,
    "    </header>",
    '    <section aria-labelledby="status-heading">',
    '      <h2 id="status-heading">Batch status</h2>',
    "      <p>This report preserves per-skill lineage and execution status. It does not invent an overall pass rate or rollout decision across heterogeneous skills.</p>",
    `      <dl class="summary-grid">${summaryRows}</dl>`,
    "    </section>",
    '    <section aria-labelledby="entries-heading">',
    '      <h2 id="entries-heading">Entries</h2>',
    '      <div class="table-wrap">',
    "        <table>",
    "          <caption>Per-skill execution status, provider metadata, and artifact lineage.</caption>",
    '          <thead><tr><th scope="col">Skill</th><th scope="col">Spec</th><th scope="col">Status</th><th scope="col">Models / provider metadata</th><th scope="col">Result</th><th scope="col">Bundle</th><th scope="col">Diagnostics</th></tr></thead>',
    `          <tbody>${entryBody}</tbody>`,
    "        </table>",
    "      </div>",
    "    </section>",
    "  </main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
