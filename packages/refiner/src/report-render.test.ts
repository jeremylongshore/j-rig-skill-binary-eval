import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderReportHtml,
  parseReport,
  renderTrajectoryChart,
  ReportRenderError,
  SKILL_REFINER_PASS_V1_URI,
} from "./report-render.js";

const FIXTURE_DIR = join(__dirname, "__fixtures__", "report-render");
const SAMPLE_MD = readFileSync(join(FIXTURE_DIR, "sample-accept.report.md"), "utf8");
const GOLDEN_HTML = readFileSync(join(FIXTURE_DIR, "sample-accept.golden.html"), "utf8");

describe("renderReportHtml — determinism (single source of truth)", () => {
  it("produces byte-identical HTML across repeated renders", () => {
    const a = renderReportHtml(SAMPLE_MD);
    const b = renderReportHtml(SAMPLE_MD);
    expect(a).toBe(b);
  });

  it("matches the committed golden HTML (proves the transform is deterministic)", () => {
    // The golden file is the frozen expected output. If this fails after an
    // intentional renderer change, regenerate it (see the fixture header) and
    // review the diff — never silently overwrite.
    expect(renderReportHtml(SAMPLE_MD)).toBe(GOLDEN_HTML);
  });

  it("carries no wall-clock or random values (same input → same output)", () => {
    // Render twice with a delay-free re-read; identical bytes prove no Date.now()
    // / Math.random() leaked into the output.
    const md2 = readFileSync(join(FIXTURE_DIR, "sample-accept.report.md"), "utf8");
    expect(renderReportHtml(md2)).toBe(renderReportHtml(SAMPLE_MD));
  });
});

describe("renderReportHtml — self-contained single-file HTML (curl-inspectable)", () => {
  const html = renderReportHtml(SAMPLE_MD);

  it("has no runtime CDN / external chart dependency (no <script src>, no http(s) chart lib)", () => {
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/cdn\./i);
    expect(html).not.toMatch(/unpkg|jsdelivr|recharts|d3js\.org/i);
  });

  it("inlines its CSS (a <style> block, no <link rel=stylesheet>)", () => {
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
  });

  it("renders the score-trajectory chart as inline SVG", () => {
    expect(html).toContain("<svg");
    expect(html).toContain('class="chart"');
  });
});

describe("renderReportHtml — required content (SPEC § 6 / § 7 / § 8)", () => {
  const html = renderReportHtml(SAMPLE_MD);

  it("renders all 10 required section headings, numbered and in order", () => {
    for (let n = 1; n <= 10; n++) {
      expect(html).toContain(`id="s${n}"`);
    }
    // Section order: s1 appears before s2 … before s10 in the document.
    const positions = Array.from({ length: 10 }, (_, i) => html.indexOf(`id="s${i + 1}"`));
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("renders the before/after behavioral table with the behavioral + named rows", () => {
    expect(html).toContain("behavioral");
    expect(html).toContain("readability");
    expect(html).toContain("brevity");
  });

  it("renders the verdict banner making the accept predicate visible at a glance", () => {
    expect(html).toContain('class="verdict accept"');
    expect(html).toContain("ACCEPT");
    expect(html).toContain("Pareto-dominant");
  });

  it("renders the behavioral delta in the hero", () => {
    expect(html).toContain("+0.1200");
  });

  it("renders and links the evals.* predicate URI, and NEVER declares labs.*", () => {
    expect(html).toContain(`href="${SKILL_REFINER_PASS_V1_URI}"`);
    expect(html).not.toContain("labs.intentsolutions.io");
  });

  it("renders the cosign verify-blob command from § 7", () => {
    expect(html).toContain("cosign verify-blob");
  });

  it("renders the accepted-edit unified diff with add/delete coloring", () => {
    expect(html).toContain('class="diff"');
    expect(html).toContain('class="add"');
    expect(html).toContain('class="del"');
  });

  it("renders staging signing state (rekor index null) from the header", () => {
    expect(html).toContain("staging");
  });
});

describe("parseReport — conformance gate (SPEC § 13)", () => {
  it("parses the sample report into 10 ordered sections + the score rows", () => {
    const parsed = parseReport(SAMPLE_MD);
    expect(parsed.sections).toHaveLength(10);
    expect(parsed.verdict).toBe("accept");
    expect(parsed.scoreRows.map((r) => r.dimension)).toEqual([
      "behavioral",
      "readability",
      "brevity",
    ]);
    const behavioral = parsed.scoreRows.find((r) => r.dimension === "behavioral")!;
    expect(behavioral.delta).toBeCloseTo(0.12, 6);
  });

  it("REFUSES a report that references a labs.* predicate URI (CISO binding)", () => {
    const bad = SAMPLE_MD.replace(
      "https://evals.intentsolutions.io/skill-refiner-pass/v1",
      "https://labs.intentsolutions.io/skill-refiner-pass/v1",
    );
    expect(() => parseReport(bad)).toThrow(ReportRenderError);
    expect(() => parseReport(bad)).toThrow(/labs\.intentsolutions\.io/);
  });

  it("REFUSES a report missing a required section (completeness gate)", () => {
    // Drop § 10 entirely.
    const bad = SAMPLE_MD.replace(/## 10\. Status banding[\s\S]*$/, "").trimEnd() + "\n";
    expect(() => parseReport(bad)).toThrow(/exactly 10 numbered sections/);
  });

  it("REFUSES a report whose sections are out of order", () => {
    const bad = SAMPLE_MD.replace("## 2. Eval set composition", "## 4. Eval set composition");
    expect(() => parseReport(bad)).toThrow(/in order/);
  });

  it("REFUSES a header with a verdict that is neither accept nor reject", () => {
    const bad = SAMPLE_MD.replace(
      "| Verdict                | accept",
      "| Verdict                | maybe",
    );
    expect(() => parseReport(bad)).toThrow(/must be 'accept' or 'reject'/);
  });

  it("REFUSES a § 3 with no behavioral row", () => {
    const bad = SAMPLE_MD.replace(/\| behavioral[^\n]*\n/, "");
    expect(() => parseReport(bad)).toThrow(/behavioral/);
  });
});

describe("renderTrajectoryChart — deterministic inline SVG", () => {
  it("emits one baseline + one candidate bar per dimension row", () => {
    const parsed = parseReport(SAMPLE_MD);
    const svg = renderTrajectoryChart(parsed.scoreRows);
    // 3 dimensions × 2 bars = 6 <rect> elements.
    const rects = svg.match(/<rect\b/g) ?? [];
    expect(rects).toHaveLength(6);
    expect(svg).toContain("<svg");
    expect(svg).toContain("behavioral");
  });

  it("is a pure function of its input rows (no random / clock)", () => {
    const parsed = parseReport(SAMPLE_MD);
    expect(renderTrajectoryChart(parsed.scoreRows)).toBe(renderTrajectoryChart(parsed.scoreRows));
  });
});
