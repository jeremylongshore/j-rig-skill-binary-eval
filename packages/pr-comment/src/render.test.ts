import { describe, it, expect } from "vitest";
import {
  renderPrComment,
  openMarker,
  closeMarker,
  hasMarker,
  findCommentWithMarker,
  type RenderableDecision,
} from "./render.js";

function allowDecision(): RenderableDecision {
  return {
    decision: "allow",
    reasons: [],
    evaluated: {
      required_gates: [
        { pattern: "j-rig:*:coverage", status: "pass", matched_gate_ids: ["j-rig:ci:coverage"] },
      ],
      rows: [
        {
          index: 0,
          gate_id: "j-rig:ci:coverage",
          gate_decision: "pass",
          blocking: false,
          reasons: [],
        },
      ],
    },
  };
}

function blockDecision(): RenderableDecision {
  return {
    decision: "block",
    reasons: [
      "required gate 'j-rig:*:coverage' present but not passing ('j-rig:ci:coverage'=fail)",
      "forbidden decision 'fail' from gate 'j-rig:ci:coverage' at index 0",
    ],
    evaluated: {
      required_gates: [
        {
          pattern: "j-rig:*:coverage",
          status: "not-passing",
          matched_gate_ids: ["j-rig:ci:coverage"],
        },
        { pattern: "j-rig:*:escape", status: "missing", matched_gate_ids: [] },
      ],
      rows: [
        {
          index: 0,
          gate_id: "j-rig:ci:coverage",
          gate_decision: "fail",
          blocking: true,
          reasons: ["forbidden decision 'fail' from gate 'j-rig:ci:coverage' at index 0"],
        },
        {
          index: 1,
          gate_id: "j-rig:ci:lint",
          gate_decision: "advisory",
          blocking: false,
          reasons: [],
        },
      ],
    },
  };
}

describe("renderPrComment — structure & markers", () => {
  it("wraps the body in opening + closing markers for the default key", () => {
    const out = renderPrComment(allowDecision());
    expect(out.startsWith(openMarker())).toBe(true);
    expect(out.trimEnd().endsWith(closeMarker())).toBe(true);
  });

  it("honors a custom marker key", () => {
    const out = renderPrComment(allowDecision(), { key: "eval-pack-1" });
    expect(out).toContain(openMarker("eval-pack-1"));
    expect(out).toContain(closeMarker("eval-pack-1"));
    expect(out).not.toContain(openMarker("default"));
  });

  it("ends with a trailing newline", () => {
    expect(renderPrComment(allowDecision()).endsWith("\n")).toBe(true);
  });

  it("uses the default title when none is given", () => {
    expect(renderPrComment(allowDecision())).toContain("## Rollout Gate — ✅ ALLOW");
  });

  it("uses a custom title", () => {
    const out = renderPrComment(allowDecision(), { title: "Skill Eval" });
    expect(out).toContain("## Skill Eval — ✅ ALLOW");
  });

  it("falls back to the default title when a blank title is given", () => {
    const out = renderPrComment(allowDecision(), { title: "   " });
    expect(out).toContain("## Rollout Gate — ✅ ALLOW");
  });
});

describe("renderPrComment — idempotency", () => {
  it("renders byte-identical output for identical input", () => {
    const a = renderPrComment(blockDecision(), { key: "x" });
    const b = renderPrComment(blockDecision(), { key: "x" });
    expect(a).toBe(b);
  });

  it("hasMarker detects the opening marker for a key", () => {
    const out = renderPrComment(allowDecision(), { key: "k1" });
    expect(hasMarker(out, "k1")).toBe(true);
    expect(hasMarker(out, "other")).toBe(false);
  });

  it("findCommentWithMarker returns the matching existing comment", () => {
    const existing = [
      { id: 1, body: "unrelated comment" },
      { id: 2, body: renderPrComment(allowDecision(), { key: "k2" }) },
      { id: 3, body: null },
    ];
    const found = findCommentWithMarker(existing, "k2");
    expect(found?.id).toBe(2);
  });

  it("findCommentWithMarker returns null when no comment matches", () => {
    const existing = [{ id: 1, body: "nothing here" }];
    expect(findCommentWithMarker(existing, "missing")).toBeNull();
  });

  it("tolerates comments with undefined body", () => {
    const existing = [{ id: 1 }, { id: 2, body: openMarker("z") }];
    expect(findCommentWithMarker(existing, "z")?.id).toBe(2);
  });
});

describe("renderPrComment — allow verdict", () => {
  it("renders an allow summary line and no 'Why blocked' section", () => {
    const out = renderPrComment(allowDecision());
    expect(out).toContain("Rollout permitted.");
    expect(out).not.toContain("### Why blocked");
  });

  it("pluralizes the row count correctly for a single row", () => {
    const out = renderPrComment(allowDecision());
    expect(out).toContain("**1** evidence row.");
  });

  it("pluralizes the row count correctly for multiple rows", () => {
    const d = allowDecision();
    d.evaluated.rows.push({
      index: 1,
      gate_id: "j-rig:ci:lint",
      gate_decision: "pass",
      blocking: false,
      reasons: [],
    });
    const out = renderPrComment(d);
    expect(out).toContain("**2** evidence rows.");
  });
});

describe("renderPrComment — block verdict", () => {
  it("renders a 'Why blocked' section listing every reason", () => {
    const out = renderPrComment(blockDecision());
    expect(out).toContain("### Why blocked");
    expect(out).toContain("- required gate 'j-rig:*:coverage' present but not passing");
    expect(out).toContain("- forbidden decision 'fail' from gate");
  });

  it("counts blocking rows and reasons in the summary", () => {
    const out = renderPrComment(blockDecision());
    expect(out).toContain("**1** of **2** rows blocking");
    expect(out).toContain("**2** reasons.");
  });

  it("renders the required-gate table with statuses", () => {
    const out = renderPrComment(blockDecision());
    expect(out).toContain("### Required gates");
    expect(out).toContain("🚫 not passing");
    expect(out).toContain("🚫 missing");
  });

  it("renders an em-dash for a required gate with no matches", () => {
    const out = renderPrComment(blockDecision());
    // The 'escape' pattern matched nothing → matched column is —.
    const escapeLine = out.split("\n").find((l) => l.includes("escape"));
    expect(escapeLine).toContain("| — |");
  });
});

describe("renderPrComment — evidence rows", () => {
  it("renders one table row per evidence row with decision labels", () => {
    const out = renderPrComment(blockDecision());
    expect(out).toContain("### Evidence rows");
    expect(out).toContain("❌ fail");
    expect(out).toContain("⚠️ advisory");
  });

  it("renders an invalid-row label when gate_id is null", () => {
    const d = blockDecision();
    d.evaluated.rows.push({
      index: 2,
      gate_id: null,
      gate_decision: null,
      blocking: true,
      reasons: ["schema-invalid row at index 2: predicate: required"],
    });
    const out = renderPrComment(d);
    expect(out).toContain("_(invalid)_");
    expect(out).toContain("— invalid");
    expect(out).toContain("(1 schema-invalid)");
  });

  it("shows blocking reasons in the result column for a blocking row", () => {
    const out = renderPrComment(blockDecision());
    expect(out).toContain("forbidden decision 'fail' from gate 'j-rig:ci:coverage' at index 0");
  });

  it("shows 'ok' for a non-blocking row", () => {
    const out = renderPrComment(blockDecision());
    const lintLine = out.split("\n").find((l) => l.includes("j-rig:ci:lint"));
    expect(lintLine).toContain("| ok |");
  });

  it("shows a bare 'blocking' label when a blocking row carries no reasons", () => {
    const d = allowDecision();
    d.decision = "block";
    d.reasons = ["some global reason"];
    d.evaluated.rows[0].blocking = true;
    d.evaluated.rows[0].reasons = [];
    const out = renderPrComment(d);
    const row = out.split("\n").find((l) => l.startsWith("| 0 |"));
    expect(row).toContain("| blocking |");
  });
});

describe("renderPrComment — truncation", () => {
  it("truncates rows past maxRows and notes the remainder", () => {
    const d = allowDecision();
    d.evaluated.rows = Array.from({ length: 5 }, (_, i) => ({
      index: i,
      gate_id: `j-rig:ci:gate-${i}`,
      gate_decision: "pass" as const,
      blocking: false,
      reasons: [],
    }));
    const out = renderPrComment(d, { maxRows: 2 });
    expect(out).toContain("…and 3 more");
    expect(out).toContain("j-rig:ci:gate-0");
    expect(out).toContain("j-rig:ci:gate-1");
    expect(out).not.toContain("j-rig:ci:gate-4");
  });

  it("does not add a truncation note when rows fit", () => {
    const out = renderPrComment(allowDecision(), { maxRows: 10 });
    expect(out).not.toContain("…and");
  });
});

describe("renderPrComment — details URL", () => {
  it("renders a details link when a URL is supplied", () => {
    const out = renderPrComment(allowDecision(), {
      detailsUrl: "https://example.test/run/42",
    });
    expect(out).toContain("[View full evidence bundle](https://example.test/run/42)");
  });

  it("omits the details link for an empty URL", () => {
    const out = renderPrComment(allowDecision(), { detailsUrl: "  " });
    expect(out).not.toContain("View full evidence bundle");
  });
});

describe("renderPrComment — escaping & injection safety", () => {
  it("escapes pipes in reason text so they cannot break the table", () => {
    const d = blockDecision();
    d.reasons = ["reason with a | pipe in it"];
    const out = renderPrComment(d);
    expect(out).toContain("reason with a \\| pipe in it");
  });

  it("collapses newlines in reasons to spaces", () => {
    const d = blockDecision();
    d.evaluated.rows[0].reasons = ["line one\nline two"];
    const out = renderPrComment(d);
    expect(out).toContain("line one line two");
  });

  it("neutralizes backticks inside gate ids", () => {
    const d = allowDecision();
    d.evaluated.rows[0].gate_id = "weird`gate";
    const out = renderPrComment(d);
    expect(out).not.toContain("weird`gate`");
    expect(out).toContain("weirdˋgate");
  });
});

describe("renderPrComment — validation", () => {
  it("rejects an invalid marker key", () => {
    expect(() => renderPrComment(allowDecision(), { key: "Bad Key!" })).toThrow(
      /invalid marker key/,
    );
  });

  it("rejects a non-integer maxRows", () => {
    expect(() => renderPrComment(allowDecision(), { maxRows: 1.5 })).toThrow(/maxRows/);
  });

  it("rejects a maxRows below 1", () => {
    expect(() => renderPrComment(allowDecision(), { maxRows: 0 })).toThrow(/maxRows/);
  });

  it("openMarker / closeMarker reject an invalid key", () => {
    expect(() => openMarker("nope key")).toThrow(/invalid marker key/);
    expect(() => closeMarker("nope key")).toThrow(/invalid marker key/);
  });
});

describe("renderPrComment — empty evaluations", () => {
  it("omits the required-gate + evidence tables when both are empty", () => {
    const d: RenderableDecision = {
      decision: "allow",
      reasons: [],
      evaluated: { required_gates: [], rows: [] },
    };
    const out = renderPrComment(d);
    expect(out).not.toContain("### Required gates");
    expect(out).not.toContain("### Evidence rows");
    expect(out).toContain("**0** evidence rows.");
  });
});
