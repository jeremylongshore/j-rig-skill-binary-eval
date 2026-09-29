import { describe, expect, it } from "vitest";
import { assessHeadroom } from "@j-rig/core";
import { formatHeadroom } from "./eval.js";

describe("formatHeadroom", () => {
  it("names saturation, the counts, and where the ceiling came from", () => {
    const line = formatHeadroom(assessHeadroom({ passed: 10, trials: 10 }));
    expect(line).toBe(
      "Eval saturated: 10/10 criteria passed (100%) at or above the 95% (default) ceiling; it cannot show that a change helped",
    );
  });

  it("describes near_ceiling with the spec-declared ceiling", () => {
    const line = formatHeadroom(assessHeadroom({ passed: 8, trials: 10, ceiling: 0.9 }));
    expect(line).toBe(
      "Eval near ceiling: 8/10 criteria passed (80%); the 95% interval reaches the 90% (spec) ceiling",
    );
  });

  it("describes headroom and no_data", () => {
    expect(formatHeadroom(assessHeadroom({ passed: 5, trials: 10 }))).toBe(
      "Eval has headroom: 5/10 criteria passed (50%) below the 95% (default) ceiling",
    );
    expect(formatHeadroom(assessHeadroom({ passed: 0, trials: 0 }))).toBe(
      "Eval headroom unknown: no criteria were scored",
    );
  });
});
