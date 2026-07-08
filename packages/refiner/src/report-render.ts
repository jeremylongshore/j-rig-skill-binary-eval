/**
 * Skill Refiner Evidence Report — deterministic markdown → HTML renderer.
 *
 * The **markdown AAR is the single source of truth** (SPEC § 10.1); the HTML
 * render is a pure, derived view (SPEC § 10.2) — never a second authoring path.
 * This module is the deterministic transform behind `j-rig refine render-report
 * <report.md>`: the same markdown in always produces byte-identical HTML out (no
 * timestamps, no random ids, no locale-dependent formatting, no CDN dependency).
 * A static report must stay curl + view-source inspectable, so the output is a
 * SELF-CONTAINED single HTML file: inline CSS, and an inline-SVG score-trajectory
 * chart (SPEC § 6.3 / § 7) drawn from the markdown's own before/after table — no
 * runtime chart library, no external fetch.
 *
 * URI-declaration discipline (SPEC § 8.1, CISO binding DR-004/DR-010): this
 * renderer RENDERS and LINKS the `evals.intentsolutions.io/skill-refiner-pass/v1`
 * predicate URI when the markdown carries it, but NEVER declares, reserves, or
 * mints one, and REFUSES to emit any `labs.intentsolutions.io` predicate URI.
 * The renderer adds no claim absent from the markdown (SPEC § 10.2) — it is a
 * projection, not an author.
 *
 * Scope: this is the RENDERER + its tests. Hosting at
 * `evals.intentsolutions.io/reports/…` is a Phase-E, human-gated deployment
 * concern (no Hugo / VPS wiring here — plan 027 lines ~640-660).
 *
 * SPEC: intent-eval-lab/specs/skill-refiner-evidence-report/v1.0.0-draft/SPEC.md
 * Plan: intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md § E.1
 */

/** The `labs.` host is reserved-don't-touch and may never appear as a predicate URI. */
const FORBIDDEN_PREDICATE_HOST = "labs.intentsolutions.io";

/** The one legal predicate URI this report renders/links (rendered, never declared). */
export const SKILL_REFINER_PASS_V1_URI =
  "https://evals.intentsolutions.io/skill-refiner-pass/v1" as const;

/** Thrown when the input markdown violates a normative rendering invariant. */
export class ReportRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportRenderError";
  }
}

/**
 * A parsed before/after behavioral table row (SPEC § 7.1). One row per evaluated
 * dimension; `behavioral` plus every named dimension. `nonRegressed` is only
 * meaningful for named dimensions (the behavioral row renders `—`).
 */
export interface ScoreRow {
  readonly dimension: string;
  readonly baseline: number;
  readonly candidate: number;
  readonly delta: number;
  /** `true` / `false` for named dims; `null` for the behavioral row / when absent. */
  readonly nonRegressed: boolean | null;
}

/** A parsed markdown report: the metadata header + the ordered § sections + the score table. */
export interface ParsedReport {
  readonly title: string;
  /** Metadata header rows as [label, value] pairs, in source order (SPEC § 5). */
  readonly header: ReadonlyArray<readonly [string, string]>;
  /** The 10 required narrative sections (SPEC § 6), keyed `1`..`10`, in order. */
  readonly sections: ReadonlyArray<{
    readonly num: number;
    readonly title: string;
    readonly body: string;
  }>;
  /** The before/after behavioral table parsed from § 3 (SPEC § 7.1). */
  readonly scoreRows: readonly ScoreRow[];
  /** The rendered verdict from the header (`accept` | `reject`). */
  readonly verdict: string;
}

const REQUIRED_SECTION_COUNT = 10;

// ── Markdown parsing (canonical source → structured model) ───────────────────

/** Split a GitHub-flavored table row `| a | b |` into trimmed cells. */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

/** True for a markdown table delimiter row like `| --- | :---: |`. */
function isTableDelimiter(line: string): boolean {
  // Single anchored character class (`|`, `-`, `:`, whitespace) — a delimiter
  // row like `| --- | :---: |` is entirely these chars. One quantifier between
  // anchors is linear: no overlapping `\s*`/`\s+` runs that could backtrack.
  return /^[\s:|-]+$/.test(line) && line.includes("-");
}

/**
 * True iff the markdown carries a URL whose host is the reserved
 * `labs.intentsolutions.io` (or a subdomain of it). We parse candidate URL
 * tokens and compare the parsed host — NOT a raw substring — so prose that
 * merely mentions the host is fine; only a real URL is a violation (SPEC § 8.1),
 * and an attacker cannot smuggle the host as an arbitrary substring of another.
 */
function referencesForbiddenPredicateHost(markdown: string): boolean {
  const urlTokens = markdown.match(/https?:\/\/[^\s)\]}<>"']+/gi) ?? [];
  for (const tok of urlTokens) {
    let host: string;
    try {
      host = new URL(tok).host.toLowerCase();
    } catch {
      continue; // not a parseable URL
    }
    if (host === FORBIDDEN_PREDICATE_HOST || host.endsWith("." + FORBIDDEN_PREDICATE_HOST)) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a canonical Skill Refiner Evidence Report markdown document into the
 * structured {@link ParsedReport}. Enforces the BLOCKING completeness gate
 * (SPEC § 13): all 10 numbered sections, in order, and the URI discipline.
 */
export function parseReport(markdown: string): ParsedReport {
  if (referencesForbiddenPredicateHost(markdown)) {
    throw new ReportRenderError(
      `report references a ${FORBIDDEN_PREDICATE_HOST} URL — that host is reserved-don't-touch and MUST NOT appear as a predicate URI (SPEC § 8.1, CISO binding)`,
    );
  }

  const lines = markdown.split("\n");

  // H1 title.
  const titleLine = lines.find((l) => /^#\s+/.test(l));
  if (!titleLine) throw new ReportRenderError("report has no H1 title");
  const title = titleLine.replace(/^#\s+/, "").trim();

  // Metadata header table: the FIRST table in the document, appearing before `## 1`.
  const header = parseHeaderTable(lines);
  const verdictCell = header.find(([k]) => k.toLowerCase() === "verdict");
  const verdict = (verdictCell?.[1] ?? "").trim();
  if (verdict !== "accept" && verdict !== "reject") {
    throw new ReportRenderError(
      `metadata header 'Verdict' must be 'accept' or 'reject' (SPEC § 5), got '${verdict}'`,
    );
  }

  // The 10 required sections.
  const sections = parseSections(lines);
  if (sections.length !== REQUIRED_SECTION_COUNT) {
    throw new ReportRenderError(
      `report must carry exactly ${REQUIRED_SECTION_COUNT} numbered sections (SPEC § 6/§ 13), found ${sections.length}`,
    );
  }
  sections.forEach((s, i) => {
    if (s.num !== i + 1) {
      throw new ReportRenderError(
        `sections must be numbered 1..${REQUIRED_SECTION_COUNT} in order (SPEC § 6); saw section ${s.num} at position ${i + 1}`,
      );
    }
  });

  // The before/after behavioral table from § 3 (Score trajectory).
  const scoreSection = sections.find((s) => s.num === 3);
  const scoreRows = scoreSection ? parseScoreTable(scoreSection.body) : [];
  if (scoreRows.length === 0) {
    throw new ReportRenderError(
      "§ 3 (Score trajectory) must carry a before/after behavioral table with at least the behavioral row (SPEC § 7.1)",
    );
  }
  if (!scoreRows.some((r) => r.dimension === "behavioral")) {
    throw new ReportRenderError(
      "the before/after table must include the 'behavioral' row (SPEC § 7.1)",
    );
  }

  return { title, header, sections, scoreRows, verdict };
}

/** Parse the metadata header table (SPEC § 5): the first 2-col table before `## 1`. */
function parseHeaderTable(lines: string[]): Array<readonly [string, string]> {
  const firstSectionIdx = lines.findIndex((l) => /^##\s+1\b/.test(l) || /^##\s+1\./.test(l));
  const scanEnd = firstSectionIdx === -1 ? lines.length : firstSectionIdx;
  const rows: Array<readonly [string, string]> = [];
  let inTable = false;
  let sawDelimiter = false;
  for (let i = 0; i < scanEnd; i++) {
    const line = lines[i];
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    if (isRow && isTableDelimiter(line)) {
      sawDelimiter = true;
      inTable = true;
      continue;
    }
    if (isRow) {
      const cells = splitTableRow(line);
      if (cells.length >= 2) {
        // Skip the header row (`| Field | Value |`) — it precedes the delimiter.
        if (!sawDelimiter) {
          inTable = true;
          continue;
        }
        rows.push([cells[0], cells[1]] as const);
      }
      continue;
    }
    // A blank/non-row line ends the header table once we've been inside one.
    if (inTable && sawDelimiter) break;
  }
  if (rows.length === 0) {
    throw new ReportRenderError("report has no metadata header table (SPEC § 5)");
  }
  return rows;
}

/** Parse the 10 numbered `## N Title` sections and their bodies (SPEC § 6). */
function parseSections(lines: string[]): Array<{ num: number; title: string; body: string }> {
  const out: Array<{ num: number; title: string; body: string }> = [];
  let current: { num: number; title: string; bodyLines: string[] } | null = null;
  // ONE whitespace quantifier (anchored by `^##`, followed by a mandatory digit)
  // plus a zero-width lookahead requiring a separator — no second `+`, so there
  // are no two competing whitespace runs that could backtrack. The title is the
  // remainder of the line after the matched prefix, trimmed.
  const headingRe = /^##[ \t]+(\d+)[.)]?(?=[ \t])/;
  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      if (current)
        out.push({
          num: current.num,
          title: current.title,
          body: current.bodyLines.join("\n").trim(),
        });
      current = { num: Number(m[1]), title: line.slice(m[0].length).trim(), bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current)
    out.push({ num: current.num, title: current.title, body: current.bodyLines.join("\n").trim() });
  return out;
}

/**
 * Parse the before/after behavioral table (SPEC § 7.1) out of a § 3 body. The
 * table's columns are: dimension | baseline | candidate | delta | non_regressed.
 */
function parseScoreTable(body: string): ScoreRow[] {
  const lines = body.split("\n");
  const rows: ScoreRow[] = [];
  let headerCells: string[] | null = null;
  let sawDelimiter = false;
  for (const line of lines) {
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      // A non-table line after we've collected rows ends the table.
      if (rows.length > 0) break;
      continue;
    }
    if (isTableDelimiter(line)) {
      sawDelimiter = true;
      continue;
    }
    const cells = splitTableRow(line);
    if (!headerCells) {
      headerCells = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (!sawDelimiter) continue;
    const idx = (name: string): number => headerCells!.findIndex((h) => h.includes(name));
    const di = idx("dimension");
    const bi = idx("baseline");
    const ci = idx("candidate");
    const dli = idx("delta");
    const nri = headerCells.findIndex((h) => h.includes("non") && h.includes("regress"));
    if (di === -1 || bi === -1 || ci === -1 || dli === -1) continue;
    const dimension = cells[di];
    if (dimension === undefined) {
      throw new ReportRenderError(
        "before/after table row has fewer columns than the header (SPEC § 7.1)",
      );
    }
    const baseline = parseNumber(cells[bi]);
    const candidate = parseNumber(cells[ci]);
    const delta = parseNumber(cells[dli]);
    const nrCell = nri === -1 ? "" : (cells[nri] ?? "").toLowerCase().replace(/[—\-\s]/g, "");
    const nonRegressed = nrCell === "true" ? true : nrCell === "false" ? false : null;
    rows.push({ dimension, baseline, candidate, delta, nonRegressed });
  }
  return rows;
}

/** Parse a numeric cell, tolerating a leading `+` and surrounding markup. */
function parseNumber(cell: string | undefined): number {
  if (cell === undefined) {
    // A row with fewer columns than the header indexes past its cells — fail
    // closed with a clear message instead of a TypeError on undefined.
    throw new ReportRenderError(
      "before/after table row is missing a required numeric cell (SPEC § 7.1)",
    );
  }
  const cleaned = cell.replace(/[`*]/g, "").replace(/^\+/, "").trim();
  const n = Number(cleaned);
  if (Number.isNaN(n)) {
    throw new ReportRenderError(`before/after table cell is not a number: '${cell}' (SPEC § 7.1)`);
  }
  return n;
}

// ── HTML rendering (derived view) ────────────────────────────────────────────

/** HTML-escape text for safe insertion into element bodies / attribute values. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format a signed delta with a fixed number of decimals (deterministic). */
function fmtDelta(n: number): string {
  const s = n.toFixed(4);
  return n > 0 ? `+${s}` : s;
}

/**
 * Render a self-contained inline-SVG score-trajectory chart (SPEC § 6.3 / § 7.2):
 * a grouped baseline-vs-candidate bar set per dimension, keyed on behavioral vs
 * named, so the Pareto-dominance outcome is unambiguous at a glance. Pure: no
 * random ids, no timestamps — bar coordinates are a deterministic function of the
 * rows. No CDN, no JS chart lib.
 */
export function renderTrajectoryChart(rows: readonly ScoreRow[]): string {
  const width = 720;
  const rowH = 44;
  const top = 28;
  const labelW = 160;
  const barMax = width - labelW - 90;
  const height = top + rows.length * rowH + 16;
  // Fixed 0..1 score domain (behavioral + named dims are rates in [0,1]).
  const scale = (v: number): number => Math.max(0, Math.min(1, v)) * barMax;

  const bars = rows
    .map((r, i) => {
      const y = top + i * rowH;
      const isBehavioral = r.dimension === "behavioral";
      const baseW = scale(r.baseline);
      const candW = scale(r.candidate);
      const baseFill = "#94a3b8";
      const candFill = isBehavioral ? "#2563eb" : r.nonRegressed === false ? "#dc2626" : "#16a34a";
      const label = esc(r.dimension) + (isBehavioral ? " (behavioral)" : "");
      return [
        `<text x="8" y="${y + 14}" class="cLbl">${label}</text>`,
        `<rect x="${labelW}" y="${y + 2}" width="${baseW.toFixed(2)}" height="12" fill="${baseFill}"><title>baseline ${r.baseline}</title></rect>`,
        `<rect x="${labelW}" y="${y + 18}" width="${candW.toFixed(2)}" height="12" fill="${candFill}"><title>candidate ${r.candidate}</title></rect>`,
        `<text x="${(labelW + Math.max(baseW, candW) + 6).toFixed(2)}" y="${y + 22}" class="cDelta">${fmtDelta(r.delta)}</text>`,
      ].join("");
    })
    .join("");

  return [
    `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Score trajectory: baseline vs candidate per dimension" class="chart">`,
    `<text x="8" y="16" class="cTitle">Score trajectory — baseline (grey) vs candidate</text>`,
    bars,
    `</svg>`,
  ].join("");
}

/**
 * Render the Pareto-dominance verdict banner (SPEC § 7.2): make the accept
 * predicate visible at a glance and distinguish accept / reject outcomes.
 */
function renderVerdictBanner(parsed: ParsedReport): string {
  const behavioral = parsed.scoreRows.find((r) => r.dimension === "behavioral")!;
  const named = parsed.scoreRows.filter((r) => r.dimension !== "behavioral");
  const anyRegressed = named.some((r) => r.nonRegressed === false);
  const cls = parsed.verdict === "accept" ? "accept" : "reject";
  const detail =
    parsed.verdict === "accept"
      ? `behavioral Pareto-dominant (${fmtDelta(behavioral.delta)}); all ${named.length} named dimension(s) non-regressed`
      : anyRegressed
        ? "reject — named-dimension-regressed"
        : "reject — pareto-incomparable / no significant behavioral improvement";
  return `<div class="verdict ${cls}"><span class="vlabel">${esc(parsed.verdict.toUpperCase())}</span><span class="vdetail">${esc(detail)}</span></div>`;
}

/** Render one metadata header row as a table row (inline markdown + URI link). */
function renderHeaderRow([label, value]: readonly [string, string]): string {
  return `<tr><th>${esc(label)}</th><td>${renderInline(value)}</td></tr>`;
}

/** Turn the (single legal) predicate URI into a link; escape everything else. */
function linkifyUri(value: string): string {
  if (!value.includes(SKILL_REFINER_PASS_V1_URI)) return esc(value);
  // Linkify EVERY occurrence: split on the URI, escape each surrounding part,
  // and rejoin with the anchor. Deterministic; byte-identical to the prior
  // single-occurrence path when the URI appears once.
  const link = `<a href="${SKILL_REFINER_PASS_V1_URI}">${esc(SKILL_REFINER_PASS_V1_URI)}</a>`;
  return value
    .split(SKILL_REFINER_PASS_V1_URI)
    .map((part) => esc(part))
    .join(link);
}

/**
 * Render a required narrative section body. We deliberately keep a SMALL,
 * deterministic markdown subset (paragraphs, fenced code, GFM tables, unified
 * diffs, unordered lists) rather than pulling a full markdown engine: the report
 * is a fixed-shape artifact, and a bounded renderer keeps the output byte-stable
 * and dependency-free.
 */
function renderSectionBody(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block (incl. unified diffs and cosign verify-blob commands).
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      const cls = lang === "diff" ? ' class="diff"' : "";
      out.push(`<pre${cls}><code>${renderCode(code, lang)}</code></pre>`);
      continue;
    }
    // GFM table.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const tbl: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tbl.push(lines[i]);
        i++;
      }
      out.push(renderTable(tbl));
      continue;
    }
    // Unordered list.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`);
      continue;
    }
    // Blank line.
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph — accumulate until a blank line or a block starter.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^\s*\|.*\|\s*$/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

/** Render fenced code, colorizing +/- lines for unified diffs (SPEC § 6.4). */
function renderCode(code: string[], lang: string): string {
  if (lang !== "diff") return esc(code.join("\n"));
  return code
    .map((l) => {
      const e = esc(l);
      if (/^\+/.test(l) && !/^\+\+\+/.test(l)) return `<span class="add">${e}</span>`;
      if (/^-/.test(l) && !/^---/.test(l)) return `<span class="del">${e}</span>`;
      return e;
    })
    .join("\n");
}

/** Render a GFM table (skips the delimiter row). */
function renderTable(tbl: string[]): string {
  const rows = tbl.filter((l) => !isTableDelimiter(l));
  if (rows.length === 0) return "";
  const head = splitTableRow(rows[0]);
  const bodyRows = rows.slice(1);
  const thead = `<thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${bodyRows
    .map(
      (r) =>
        `<tr>${splitTableRow(r)
          .map((c) => `<td>${renderInline(c)}</td>`)
          .join("")}</tr>`,
    )
    .join("")}</tbody>`;
  return `<table class="section-table">${thead}${tbody}</table>`;
}

/** Minimal, deterministic inline markdown: code spans, bold, and the predicate link. */
function renderInline(text: string): string {
  // Tokenize on backtick code spans first so their contents are not further parsed.
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) {
        return `<code>${esc(part.slice(1, -1))}</code>`;
      }
      // Escape, then re-apply the (single legal) predicate link + **bold**.
      let html = linkifyUri(part);
      html = html.replace(/\*\*([^*]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);
      return html;
    })
    .join("");
}

/**
 * Render a canonical markdown Skill Refiner Evidence Report as a self-contained
 * HTML string (SPEC § 10.2). Deterministic: `renderReportHtml(md)` is byte-stable
 * for a given `md`. Adds no claim absent from the markdown.
 */
export function renderReportHtml(markdown: string): string {
  const parsed = parseReport(markdown);
  const behavioral = parsed.scoreRows.find((r) => r.dimension === "behavioral")!;

  const headerRows = parsed.header.map(renderHeaderRow).join("");
  const chart = renderTrajectoryChart(parsed.scoreRows);
  const verdictBanner = renderVerdictBanner(parsed);
  const sectionsHtml = parsed.sections
    .map(
      (s) =>
        `<section id="s${s.num}"><h2>${s.num}. ${esc(s.title)}</h2>\n${renderSectionBody(s.body)}</section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(parsed.title)}</title>
<style>
${INLINE_CSS}
</style>
</head>
<body>
<main class="report">
<header class="hero">
<h1>${esc(parsed.title)}</h1>
${verdictBanner}
<p class="hero-metric">Behavioral delta: <strong>${fmtDelta(behavioral.delta)}</strong></p>
</header>
<section class="meta">
<h2>Metadata</h2>
<table class="meta-table"><tbody>${headerRows}</tbody></table>
</section>
<section class="trajectory">
<h2>Score trajectory</h2>
${chart}
</section>
${sectionsHtml}
<footer class="foot">
<p>Deterministically rendered from the canonical markdown report — this HTML is a derived view, not a source of truth (SPEC § 10). Verify against the signed <a href="${SKILL_REFINER_PASS_V1_URI}">skill-refiner-pass/v1</a> attestation body; see § 7 for the <code>cosign verify-blob</code> command.</p>
</footer>
</main>
</body>
</html>
`;
}

/** Inline stylesheet — kept as a module constant so the render stays self-contained. */
const INLINE_CSS = `:root{--fg:#0f172a;--muted:#475569;--line:#e2e8f0;--bg:#ffffff;--accent:#2563eb}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:#f8fafc}
.report{max-width:900px;margin:0 auto;padding:2rem 1.25rem;background:var(--bg)}
h1{font-size:1.6rem;margin:0 0 .75rem}
h2{font-size:1.2rem;margin:1.75rem 0 .5rem;padding-bottom:.25rem;border-bottom:1px solid var(--line)}
.hero{border-bottom:2px solid var(--line);padding-bottom:1rem;margin-bottom:1rem}
.hero-metric{color:var(--muted);margin:.5rem 0 0}
.verdict{display:inline-flex;align-items:center;gap:.6rem;padding:.4rem .8rem;border-radius:6px;font-weight:600}
.verdict.accept{background:#dcfce7;color:#166534}
.verdict.reject{background:#fee2e2;color:#991b1b}
.vlabel{font-size:.9rem;letter-spacing:.05em}
.vdetail{font-weight:400;font-size:.85rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0;font-size:.92rem}
.meta-table th{text-align:left;white-space:nowrap;color:var(--muted);font-weight:600;padding:.3rem .75rem .3rem 0;vertical-align:top;width:1%}
.meta-table td{padding:.3rem 0;border-bottom:1px solid var(--line)}
.section-table th{text-align:left;background:#f1f5f9;padding:.4rem .6rem;border:1px solid var(--line)}
.section-table td{padding:.4rem .6rem;border:1px solid var(--line)}
pre{background:#0f172a;color:#e2e8f0;padding:.9rem 1rem;border-radius:6px;overflow:auto;font-size:.85rem}
pre.diff span.add{color:#4ade80}
pre.diff span.del{color:#f87171}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}
p code,li code,td code{background:#f1f5f9;padding:.05rem .3rem;border-radius:3px}
.chart{display:block;margin:.5rem 0;background:#fff;border:1px solid var(--line);border-radius:6px}
.chart .cTitle{font-size:12px;fill:var(--muted)}
.chart .cLbl{font-size:12px;fill:var(--fg)}
.chart .cDelta{font-size:11px;fill:var(--muted)}
a{color:var(--accent)}
.foot{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}
ul{margin:.4rem 0 .4rem 1.2rem;padding:0}`;
