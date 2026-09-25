import { describe, expect, it } from "vitest";
import {
  buildSkillPromotionEvidence,
  hashCanonicalJson,
  type SkillPromotionEvidenceInput,
} from "./skill-promotion.js";
import { canonicalJson } from "../schemas/skill-eval-spec-adapter.js";

const HASH = `sha256:${"a".repeat(64)}`;
const RUN_ID = "0192cae6-0002-7000-8000-000000000000";

const passingScore = {
  total_criteria: 2,
  passed: 2,
  failed: 0,
  unsure: 0,
  blocker_failures: 0,
  sacred_regressions: 0,
  pass_rate: 1,
  unstable_blocker_failures: 0,
};

function input(overrides: Partial<SkillPromotionEvidenceInput> = {}): SkillPromotionEvidenceInput {
  return {
    evalRunId: RUN_ID,
    storageRunId: 42,
    skill: { name: "fixture-skill", version: "1.0.0", snapshotSha256: HASH },
    evalSpec: {
      id: "j-rig:skill-profile:fixture-skill",
      version: "1.0",
      profileSha256: HASH,
    },
    selectedGrader: {
      graderId: "j-rig-binary-criteria",
      graderVersion: "0.2.0",
      graderSnapshotSha256: HASH,
    },
    score: passingScore,
    minBlockerAgreement: null,
    regressions: [],
    regressionEnabled: true,
    regressionBaselineSha256: HASH,
    baselineEnabled: false,
    baselineComparisons: [],
    isObsolete: false,
    rolloutDecision: "ship",
    ...overrides,
  };
}

describe("skill promotion evidence", () => {
  it("content-addresses snapshots independently of object key order", () => {
    expect(canonicalJson({ z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] })).toBe(
      canonicalJson({ a: [{ c: 3, d: 4 }], z: { a: 1, b: 2 } }),
    );
    expect(hashCanonicalJson({ a: 1, b: 2 })).toBe(hashCanonicalJson({ b: 2, a: 1 }));
  });

  it("allows a clean promotion only with an executed no-regression comparison", () => {
    const evidence = buildSkillPromotionEvidence(input());

    expect(evidence).toMatchObject({
      schema: "j-rig/skill-promotion/v1",
      eval_run_id: RUN_ID,
      run_ids: [RUN_ID],
      storage_run_id: 42,
      promotion_eligible: true,
      gate_decision: "pass",
      thresholds: { status: "pass", required_pass_rate: 1 },
      regression: { enabled: true, result: "no-regressions", count: 0 },
    });
  });

  it("downgrades a skipped regression layer to advisory instead of claiming pass", () => {
    const evidence = buildSkillPromotionEvidence(
      input({ regressionEnabled: false, regressionBaselineSha256: null }),
    );

    expect(evidence.promotion_eligible).toBe(false);
    expect(evidence.gate_decision).toBe("advisory");
    expect(evidence.regression).toMatchObject({
      required: true,
      enabled: false,
      result: "not-run",
      baseline_sha256: null,
    });
    expect(evidence.promotion_reasons).toContain("regression comparison was not run");
  });

  it("keeps non-sacred regressions fail-closed for promotion", () => {
    const evidence = buildSkillPromotionEvidence(
      input({
        regressions: [
          {
            criterion_id: "c1",
            previous_verdict: "yes",
            current_verdict: "no",
            is_sacred: false,
          },
        ],
      }),
    );

    expect(evidence.promotion_eligible).toBe(false);
    expect(evidence.gate_decision).toBe("advisory");
    expect(evidence.regression.result).toBe("regressions-found");
  });

  it("emits a blocking gate for a sacred regression or blocker decision", () => {
    const evidence = buildSkillPromotionEvidence(
      input({
        regressions: [
          {
            criterion_id: "c-sacred",
            previous_verdict: "yes",
            current_verdict: "no",
            is_sacred: true,
          },
        ],
        score: { ...passingScore, sacred_regressions: 1 },
        rolloutDecision: "block",
      }),
    );

    expect(evidence.promotion_eligible).toBe(false);
    expect(evidence.gate_decision).toBe("fail");
    expect(evidence.regression.sacred_count).toBe(1);
  });

  it("rejects an enabled comparison without a content-addressed baseline", () => {
    expect(() => buildSkillPromotionEvidence(input({ regressionBaselineSha256: null }))).toThrow(
      /baseline hash/,
    );
  });
});
