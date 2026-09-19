import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { EvalSpecSchema } from "@intentsolutions/core/validators/v1/eval-spec";
import {
  adaptSkillEvalSpec,
  canonicalJson,
  sha256,
  SkillEvalSpecAdapterError,
  SKILL_EVAL_SPEC_KERNEL_VERSION,
  SKILL_EVAL_SPEC_MAPPING_REVISION,
} from "./skill-eval-spec-adapter.js";
import { SkillEvalSpecSchema } from "./skill-eval-spec.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../fixtures");

function readFixture(path: string): string {
  return readFileSync(resolve(fixturesDir, path), "utf-8");
}

const adapterOptions = {
  id: "018f3f3f-3f3f-7f3f-8f3f-3f3f3f3f3f3f",
  version: "1.0.0",
  created_at: "2026-08-01T12:00:00Z",
  created_by: "j-rig-adapter-fixture",
  mapping_revision: "j-rig-skill-eval-to-eval-spec@1.0.0-test",
  expected_artifacts: ["a".repeat(64)],
  runtime_limits: {
    token_ceiling: 10000,
    wall_clock_ceiling_ms: 120000,
    memory_ceiling_mb: 512,
    concurrency_hint: 2,
  },
  provider_constraints: ["anthropic"],
};

describe("adaptSkillEvalSpec", () => {
  it("emits a strict canonical EvalSpec and complete lineage", () => {
    const sourceDocument = parseYaml(readFixture("valid/adapter-source.yaml"));
    const normalizedSource = SkillEvalSpecSchema.parse(sourceDocument);
    const result = adaptSkillEvalSpec(sourceDocument, adapterOptions);

    expect(EvalSpecSchema.safeParse(result.canonical).success).toBe(true);
    expect(result.canonical.name).toBe("adapter-fixture");
    expect(result.canonical.version).toBe("1.0.0");
    expect(result.canonical.assertions).toHaveLength(2);
    expect(result.canonical.assertions[0]).toMatchObject({
      class: "j-rig-criterion",
      extension: true,
      target: { id: "blocker-response", blocker: true, method: "judge" },
    });
    expect(result.canonical.scoring.aggregation_rule).toBe("majority");
    expect(result.canonical.expected_artifacts).toEqual(adapterOptions.expected_artifacts);
    expect(result.canonical.provider_constraints).toEqual(["anthropic"]);

    expect(result.lineage).toMatchObject({
      adapter_revision: SKILL_EVAL_SPEC_MAPPING_REVISION,
      mapping_revision: adapterOptions.mapping_revision,
      kernel_version: SKILL_EVAL_SPEC_KERNEL_VERSION,
      source_profile_version: "1.0",
      source_skill_name: "adapter-fixture",
      criterion_mappings: [
        { source_id: "blocker-response", coverage: "evaluated", blocker: true },
        { source_id: "deterministic-format", coverage: "skipped", blocker: false },
      ],
      coverage: {
        evaluated_criterion_ids: ["blocker-response"],
        skipped_criterion_ids: ["deterministic-format"],
        evaluated_test_case_ids: ["covered-request"],
        skipped_test_case_ids: ["control-request"],
      },
    });
    expect(result.lineage.test_case_coverage).toEqual([
      {
        source_id: "covered-request",
        tier: "core",
        criterion_ids: ["blocker-response"],
        coverage: "evaluated",
      },
      {
        source_id: "control-request",
        tier: "edge",
        criterion_ids: [],
        coverage: "skipped",
        trigger_expectation: "should_not_trigger",
      },
    ]);

    expect(result.lineage.source_profile_hash).toBe(sha256(canonicalJson(normalizedSource)));
    const { content_hash: canonicalHash, ...canonicalWithoutHash } = result.canonical;
    expect(canonicalHash).toBe(result.lineage.canonical_spec_hash);
    expect(canonicalHash).toBe(sha256(canonicalJson(canonicalWithoutHash)));

    const extension = result.canonical.scoring.extensions?.["j-rig-skill-eval"];
    expect(extension).toMatchObject({
      source_profile_hash: result.lineage.source_profile_hash,
      source_profile_version: "1.0",
      kernel_version: SKILL_EVAL_SPEC_KERNEL_VERSION,
      models: ["sonnet"],
      samples: 3,
    });
  });

  it("is deterministic for equivalent object key order", () => {
    const first = { z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] };
    const second = { a: [{ c: 3, d: 4 }], z: { a: 1, b: 2 } };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(sha256(canonicalJson(first))).toBe(sha256(canonicalJson(second)));
  });

  it("fails closed on an invalid profile without returning a partial result", () => {
    const invalidSource = parseYaml(readFixture("invalid/adapter-source-empty-criteria.yaml"));

    expect(() => adaptSkillEvalSpec(invalidSource, adapterOptions)).toThrow(
      SkillEvalSpecAdapterError,
    );
    try {
      adaptSkillEvalSpec(invalidSource, adapterOptions);
      throw new Error("expected adapter to reject the invalid profile");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillEvalSpecAdapterError);
      expect((error as SkillEvalSpecAdapterError).message).toMatch(
        /no canonical EvalSpec was created/,
      );
    }
  });

  it("fails closed when canonical identity options cannot satisfy the kernel", () => {
    const sourceDocument = parseYaml(readFixture("valid/adapter-source.yaml"));

    expect(() =>
      adaptSkillEvalSpec(sourceDocument, { ...adapterOptions, id: "not-uuidv7" }),
    ).toThrow(/Canonical EvalSpec validation failed/);
  });
});
