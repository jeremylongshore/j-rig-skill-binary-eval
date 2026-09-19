import type { GradeMeasurement, SamplingGrade } from "../sampling/substrate.js";
import type { UnifiedReport } from "./substrate.js";

/** Escape a value before inserting it into a static HTML projection. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function metric(value: number | string | null): string {
  return escapeHtml(value === null ? "—" : value);
}

function passRate(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

function interval(measurement: GradeMeasurement): string {
  const confidence = measurement.confidence_interval_95;
  return confidence ? `[${confidence.lower.toFixed(3)}, ${confidence.upper.toFixed(3)}]` : "—";
}

export interface UnifiedReportHtmlOptions {
  /** Optional context-specific document title, e.g. a suite id. */
  title?: string;
}

/**
 * Render a self-contained, accessible static HTML projection.
 *
 * The document intentionally contains no scripts, external assets, or network
 * fetches. User-controlled report values are escaped before insertion, so the
 * output can be opened directly from disk without turning a task/config/model
 * label into executable markup.
 */
export function renderUnifiedReportHtml(
  report: UnifiedReport,
  options: UnifiedReportHtmlOptions = {},
): string {
  const title = options.title ?? "J-Rig Unified Evaluation Report";
  const summaryRows = Object.entries(report.summary)
    .map(
      ([key, value]) =>
        `<div class="metric"><dt>${escapeHtml(key.replaceAll("_", " "))}</dt><dd>${metric(value)}</dd></div>`,
    )
    .join("");

  const cellRows = report.cells
    .map((rawCell) => {
      const cell = rawCell as unknown as GradeMeasurement;
      return (
        `<tr><th scope="row">${escapeHtml(`${cell.task_id}@${cell.task_version}`)}</th>` +
        `<td>${escapeHtml(`${cell.config_id}@${cell.config_version}`)}</td>` +
        `<td>${escapeHtml(cell.model)}</td>` +
        `<td class="numeric">${cell.completed_runs}</td>` +
        `<td class="numeric">${cell.graded_runs}</td>` +
        `<td class="numeric">${passRate(cell.pass_rate)}</td>` +
        `<td class="numeric">${escapeHtml(interval(cell))}</td>` +
        `<td class="numeric">${cell.harness_failure_count}</td>` +
        `<td class="numeric">${cell.ungraded_completed_runs}</td>` +
        `<td class="numeric">${metric(cell.mean_score?.toFixed(3) ?? null)}</td>` +
        `<td class="numeric">${metric(cell.score_standard_error?.toFixed(3) ?? null)}</td></tr>`
      );
    })
    .join("");
  const cellBody =
    cellRows || '<tr><td class="empty" colspan="11">No cell measurements are available.</td></tr>';

  const runRows = report.runs
    .map((run) => {
      const grade = run.grade as SamplingGrade | null;
      return (
        `<tr><th scope="row"><code>${escapeHtml(run.raw_run_id)}</code></th>` +
        `<td>${escapeHtml(`${run.task_id}@${run.task_version}`)}</td>` +
        `<td>${escapeHtml(`${run.config_id}@${run.config_version}`)}</td>` +
        `<td>${escapeHtml(run.model)}</td>` +
        `<td class="numeric">${run.sample_index}</td>` +
        `<td><span class="status">${escapeHtml(run.status)}</span></td>` +
        `<td><span class="status">${escapeHtml(grade?.verdict ?? "ungraded")}</span></td></tr>`
      );
    })
    .join("");
  const runBody =
    runRows || '<tr><td class="empty" colspan="7">No run data is available.</td></tr>';

  const css = `
    :root { color-scheme: light dark; --bg: #0b1020; --panel: #131b2e; --ink: #eef3ff; --muted: #a7b3ca; --line: #2b3a59; --accent: #8dd7ff; --focus: #ffd166; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1440px; margin: 0 auto; padding: 2rem clamp(1rem, 3vw, 3rem) 4rem; }
    .skip-link { position: absolute; left: 1rem; top: -4rem; background: var(--focus); color: #111; padding: .5rem .75rem; z-index: 2; }
    .skip-link:focus { top: 1rem; }
    header { border-bottom: 1px solid var(--line); margin-bottom: 2rem; padding-bottom: 1.5rem; }
    .eyebrow { color: var(--accent); font: 700 .75rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
    h1, h2 { line-height: 1.15; }
    h1 { font-size: clamp(1.8rem, 4vw, 3rem); margin: .35rem 0 .75rem; }
    h2 { font-size: 1.35rem; margin: 2.2rem 0 .8rem; }
    .meta { color: var(--muted); margin: .25rem 0; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin: 0; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: .6rem; padding: .8rem 1rem; }
    .metric dt { color: var(--muted); font-size: .8rem; text-transform: capitalize; }
    .metric dd { font-size: 1.35rem; font-weight: 700; margin: .2rem 0 0; }
    .table-wrap { border: 1px solid var(--line); border-radius: .6rem; overflow-x: auto; background: var(--panel); }
    table { border-collapse: collapse; min-width: 980px; width: 100%; }
    caption { color: var(--muted); font-size: .9rem; padding: .8rem 1rem; text-align: left; }
    th, td { border-top: 1px solid var(--line); padding: .65rem .75rem; text-align: left; vertical-align: top; }
    thead th { background: var(--panel); border-top: 0; color: var(--ink); font-size: .8rem; position: sticky; top: 0; white-space: nowrap; }
    tbody th { font-weight: 650; }
    .numeric { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
    .status { border: 1px solid var(--line); border-radius: 999px; display: inline-block; font: 700 .75rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; padding: .2rem .45rem; }
    .empty { color: var(--muted); padding: 1.2rem; text-align: center; }
    code { color: var(--accent); font: .85em ui-monospace, SFMono-Regular, Menlo, monospace; }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
    @media print { :root { color-scheme: light; --bg: #fff; --panel: #fff; --ink: #111; --muted: #555; --line: #bbb; } .table-wrap { overflow: visible; } table { min-width: 0; } thead th { position: static; } }
  `;

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(title)}</title>`,
    `  <style>${css}</style>`,
    "</head>",
    "<body>",
    '  <a class="skip-link" href="#report-main">Skip to report</a>',
    '  <main id="report-main">',
    "    <header>",
    `      <p class="eyebrow">${escapeHtml(report.schema)}</p>`,
    `      <h1>${escapeHtml(title)}</h1>`,
    `      <p class="meta">Generated: <time datetime="${escapeHtml(report.generated_at)}">${escapeHtml(report.generated_at)}</time></p>`,
    `      <p class="meta">Grader: <code>${escapeHtml(`${report.grader.grader_id}@${report.grader.grader_version}`)}</code></p>`,
    `      <p class="meta">Snapshot: <code>${escapeHtml(report.grader.grader_snapshot_sha256)}</code></p>`,
    "    </header>",
    '    <section aria-labelledby="summary-heading">',
    '      <h2 id="summary-heading">Summary</h2>',
    `      <dl class="summary-grid">${summaryRows}</dl>`,
    "    </section>",
    '    <section aria-labelledby="cells-heading">',
    '      <h2 id="cells-heading">Cells</h2>',
    '      <div class="table-wrap">',
    "        <table>",
    "          <caption>Task/config/model measurements; no heterogeneous overall pass rate is inferred.</caption>",
    '          <thead><tr><th scope="col">Task</th><th scope="col">Config</th><th scope="col">Model</th><th scope="col">Completed</th><th scope="col">Graded</th><th scope="col">Pass rate</th><th scope="col">95% Wilson</th><th scope="col">Harness failures</th><th scope="col">Ungraded</th><th scope="col">Mean score</th><th scope="col">Score SE</th></tr></thead>',
    `          <tbody>${cellBody}</tbody>`,
    "        </table>",
    "      </div>",
    "    </section>",
    '    <section aria-labelledby="runs-heading">',
    '      <h2 id="runs-heading">Runs</h2>',
    '      <div class="table-wrap">',
    "        <table>",
    "          <caption>Raw execution lineage and selected Grade verdicts.</caption>",
    '          <thead><tr><th scope="col">Raw Run</th><th scope="col">Task</th><th scope="col">Config</th><th scope="col">Model</th><th scope="col">Sample</th><th scope="col">Status</th><th scope="col">Verdict</th></tr></thead>',
    `          <tbody>${runBody}</tbody>`,
    "        </table>",
    "      </div>",
    "    </section>",
    "  </main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
