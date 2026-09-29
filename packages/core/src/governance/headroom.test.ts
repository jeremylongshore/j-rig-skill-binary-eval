import { describe, expect, it } from "vitest";
import { assessHeadroom, DEFAULT_HEADROOM_CEILING } from "./headroom.js";

describe("assessHeadroom", () => {
  it("flags a perfect score as saturated under the runtime default", () => {
    const result = assessHeadroom({ passed: 10, trials: 10 });
    expect(result.status).toBe("saturated");
    expect(result.ceiling).toBe(DEFAULT_HEADROOM_CEILING);
    expect(result.ceiling_source).toBe("default");
    expect(result.pass_rate).toBe(1);
  });

  it("treats a pass rate exactly at the ceiling as saturated", () => {
    expect(assessHeadroom({ passed: 19, trials: 20 }).status).toBe("saturated");
  });

  it("reports near_ceiling when the Wilson interval still reaches the ceiling", () => {
    const result = assessHeadroom({ passed: 9, trials: 10 });
    expect(result.status).toBe("near_ceiling");
    expect(result.confidence_interval_95?.upper).toBeGreaterThanOrEqual(0.95);
  });

  it("reports headroom when the whole interval sits below the ceiling", () => {
    const result = assessHeadroom({ passed: 8, trials: 10 });
    expect(result.status).toBe("headroom");
    expect(result.confidence_interval_95?.upper).toBeLessThan(0.95);
  });

  it("honours a spec-declared ceiling and records its source", () => {
    const result = assessHeadroom({ passed: 8, trials: 10, ceiling: 0.8 });
    expect(result.status).toBe("saturated");
    expect(result.ceiling).toBe(0.8);
    expect(result.ceiling_source).toBe("spec");
  });

  it("returns no_data rather than a verdict when nothing was scored", () => {
    const result = assessHeadroom({ passed: 0, trials: 0 });
    expect(result.status).toBe("no_data");
    expect(result.pass_rate).toBeNull();
    expect(result.confidence_interval_95).toBeNull();
  });

  it("rejects a ceiling outside (0, 1]", () => {
    expect(() => assessHeadroom({ passed: 1, trials: 2, ceiling: 0 })).toThrow(/ceiling/);
    expect(() => assessHeadroom({ passed: 1, trials: 2, ceiling: 1.2 })).toThrow(/ceiling/);
    expect(() => assessHeadroom({ passed: 1, trials: 2, ceiling: Number.NaN })).toThrow(/ceiling/);
  });
});
