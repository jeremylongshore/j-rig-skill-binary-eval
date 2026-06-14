import { describe, it, expect } from "vitest";
import { decide, type DecideResult } from "@intentsolutions/rollout-gate";
import { renderPrComment, type RenderableDecision } from "./render.js";

/**
 * Structural-compatibility guard: a real `DecideResult` from the rollout gate
 * must flow into `renderPrComment` with NO adapter. If the rollout gate's
 * result shape drifts, this test fails at typecheck or assertion time.
 */
describe("pr-comment ↔ rollout-gate compatibility", () => {
  it("renders a real decide() block decision (empty bundle → block)", () => {
    const result: DecideResult = decide([], { required_gates: ["j-rig:*:coverage"] });
    // The assignment below is the load-bearing structural check.
    const renderable: RenderableDecision = result;
    const out = renderPrComment(renderable);
    expect(result.decision).toBe("block");
    expect(out).toContain("🚫 BLOCK");
  });

  it("renders a real decide() allow decision", () => {
    const bundle = [
      {
        _type: "https://in-toto.io/Statement/v1",
        subject: [
          {
            name: "j-rig:ci:coverage",
            digest: { sha256: "a".repeat(64) },
          },
        ],
        predicateType: "https://evals.intentsolutions.io/gate-result/v1",
        predicate: {
          gate_id: "j-rig:ci:coverage",
          gate_name: "coverage-check",
          gate_version: "2.0.0",
          gate_decision: "pass",
          gate_reasons: ["all criteria met"],
          coverage: { dimensions_evaluated: ["lines"], dimensions_skipped: [] },
          policy_ref: `sha256:${"b".repeat(64)}:vitest.config.ts`,
          policy_hash: `sha256:${"c".repeat(64)}`,
          input_hash: `sha256:${"a".repeat(64)}`,
          evaluated_at: "2026-06-13T00:00:00.000Z",
          runner: "j-rig@2.0.0",
          commit_sha: "abc1234",
        },
      },
    ];
    const result = decide(bundle, { required_gates: ["j-rig:*:coverage"] });
    expect(result.decision).toBe("allow");
    const out = renderPrComment(result);
    expect(out).toContain("✅ ALLOW");
    expect(out).toContain("Rollout permitted.");
  });
});
