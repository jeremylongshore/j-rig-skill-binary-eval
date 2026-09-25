import { createHash } from "node:crypto";
import { z } from "zod";
import { EvalSpecSchema } from "@intentsolutions/core/validators/v1/eval-spec";
import type { EvalSpec } from "@intentsolutions/core/validators/v1/eval-spec";
import type { Criterion } from "./criterion.js";
import { SkillEvalSpecSchema } from "./skill-eval-spec.js";
import type { SkillEvalSpec } from "./skill-eval-spec.js";

/** The kernel version this adapter emits and validates against. */
export const SKILL_EVAL_SPEC_KERNEL_VERSION = "0.10.0" as const;

/** Default mapping revision; change it whenever the projection semantics change. */
export const SKILL_EVAL_SPEC_MAPPING_REVISION = "j-rig-skill-eval-to-eval-spec@1.0.0" as const;

const RuntimeLimitsInputSchema = z
  .object({
    token_ceiling: z.number().int().nonnegative(),
    wall_clock_ceiling_ms: z.number().int().nonnegative(),
    memory_ceiling_mb: z.number().int().nonnegative(),
    concurrency_hint: z.number().int().nonnegative(),
  })
  .strict();

const AdapterOptionsSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  created_at: z.string().min(1),
  created_by: z.string().min(1),
  mapping_revision: z.string().min(1).default(SKILL_EVAL_SPEC_MAPPING_REVISION),
  expected_artifacts: z.array(z.string()).default([]),
  runtime_limits: RuntimeLimitsInputSchema,
  provider_constraints: z.array(z.string()).default([]),
});

/** Required canonical identity and runtime fields supplied by the caller. */
export type SkillEvalSpecAdapterOptions = z.input<typeof AdapterOptionsSchema>;

export type SkillEvalCoverage = "evaluated" | "skipped";

export interface SkillEvalCriterionMapping {
  readonly source_id: string;
  readonly canonical_assertion_index: number;
  readonly method: Criterion["method"];
  readonly blocker: boolean;
  readonly regression_critical: boolean;
  readonly baseline_sensitive: boolean;
  readonly pack_sensitive: boolean;
  readonly coverage: SkillEvalCoverage;
}

export interface SkillEvalTestCaseCoverage {
  readonly source_id: string;
  readonly tier: SkillEvalSpec["test_cases"][number]["tier"];
  readonly criterion_ids: readonly string[];
  readonly coverage: SkillEvalCoverage;
  readonly trigger_expectation?: SkillEvalSpec["test_cases"][number]["trigger_expectation"];
}

export interface SkillEvalSpecLineage {
  readonly adapter_revision: typeof SKILL_EVAL_SPEC_MAPPING_REVISION;
  readonly mapping_revision: string;
  readonly kernel_version: typeof SKILL_EVAL_SPEC_KERNEL_VERSION;
  readonly source_profile_hash: string;
  readonly source_profile_version: SkillEvalSpec["spec_version"];
  readonly source_skill_name: string;
  readonly canonical_spec_hash: string;
  readonly criterion_mappings: readonly SkillEvalCriterionMapping[];
  readonly test_case_coverage: readonly SkillEvalTestCaseCoverage[];
  readonly coverage: {
    readonly evaluated_criterion_ids: readonly string[];
    readonly skipped_criterion_ids: readonly string[];
    readonly evaluated_test_case_ids: readonly string[];
    readonly skipped_test_case_ids: readonly string[];
  };
}

export interface SkillEvalSpecAdapterResult {
  readonly canonical: EvalSpec;
  readonly lineage: SkillEvalSpecLineage;
}

/** Structured failure used for both profile and canonical validation errors. */
export class SkillEvalSpecAdapterError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.name = "SkillEvalSpecAdapterError";
    this.issues = issues;
  }
}

/**
 * Stable JSON for content addressing. Object keys are sorted recursively while
 * arrays retain their declared order because test-case and criterion order is
 * meaningful to the source profile.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Lowercase hexadecimal SHA-256 for the adapter's content-addressed values. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

function issuesFrom(result: {
  error: { issues: readonly { path: PropertyKey[]; message: string }[] };
}): string[] {
  return result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}

function criterionTarget(criterion: Criterion): Record<string, unknown> {
  return {
    id: criterion.id,
    description: criterion.description,
    method: criterion.method,
    blocker: criterion.blocker,
    regression_critical: criterion.regression_critical,
    baseline_sensitive: criterion.baseline_sensitive,
    pack_sensitive: criterion.pack_sensitive,
    ...(criterion.judge_prompt === undefined ? {} : { judge_prompt: criterion.judge_prompt }),
    ...(criterion.samples === undefined ? {} : { samples: criterion.samples }),
    ...(criterion.judge_temperature === undefined
      ? {}
      : { judge_temperature: criterion.judge_temperature }),
    ...(criterion.deterministic_check === undefined
      ? {}
      : { deterministic_check: criterion.deterministic_check }),
    ...(criterion.deterministic_check_params === undefined
      ? {}
      : { deterministic_check_params: criterion.deterministic_check_params }),
  };
}

function sourceCriteriaForTestCase(
  testCase: SkillEvalSpec["test_cases"][number],
  allIds: string[],
) {
  return testCase.criteria_ids === undefined ? allIds : testCase.criteria_ids;
}

/**
 * Adapt a validated J-Rig skill profile into the canonical kernel EvalSpec.
 *
 * The returned canonical object intentionally contains no lineage fields at
 * its top level: the kernel schema is strict. Callers must persist the
 * returned `lineage` envelope beside the canonical spec before emitting shared
 * evidence or rollout claims.
 *
 * Profile validation happens before any projection work. Invalid input throws
 * `SkillEvalSpecAdapterError` and cannot return a partial canonical object.
 */
export function adaptSkillEvalSpec(
  profile: unknown,
  options: SkillEvalSpecAdapterOptions,
): SkillEvalSpecAdapterResult {
  const parsedProfile = SkillEvalSpecSchema.safeParse(profile);
  if (!parsedProfile.success) {
    throw new SkillEvalSpecAdapterError(
      "SkillEvalSpec validation failed; no canonical EvalSpec was created",
      issuesFrom(parsedProfile),
    );
  }

  const parsedOptions = AdapterOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    throw new SkillEvalSpecAdapterError(
      "SkillEvalSpec adapter options are invalid; no canonical EvalSpec was created",
      issuesFrom(parsedOptions),
    );
  }

  const source = parsedProfile.data;
  const adapterOptions = parsedOptions.data;
  const sourceProfileHash = sha256(canonicalJson(source));
  const allCriterionIds = source.criteria.map((criterion) => criterion.id);
  const evaluatedCriterionIds = new Set<string>();

  const testCaseCoverage: SkillEvalTestCaseCoverage[] = source.test_cases.map((testCase) => {
    const criterionIds = sourceCriteriaForTestCase(testCase, allCriterionIds);
    for (const criterionId of criterionIds) evaluatedCriterionIds.add(criterionId);
    return {
      source_id: testCase.id,
      tier: testCase.tier,
      criterion_ids: [...criterionIds],
      coverage: criterionIds.length > 0 ? "evaluated" : "skipped",
      ...(testCase.trigger_expectation === undefined
        ? {}
        : { trigger_expectation: testCase.trigger_expectation }),
    };
  });

  const skippedCriterionIds = allCriterionIds.filter((id) => !evaluatedCriterionIds.has(id));
  const criterionMappings: SkillEvalCriterionMapping[] = source.criteria.map(
    (criterion, canonicalAssertionIndex) => ({
      source_id: criterion.id,
      canonical_assertion_index: canonicalAssertionIndex,
      method: criterion.method,
      blocker: criterion.blocker,
      regression_critical: criterion.regression_critical,
      baseline_sensitive: criterion.baseline_sensitive,
      pack_sensitive: criterion.pack_sensitive,
      coverage: evaluatedCriterionIds.has(criterion.id) ? "evaluated" : "skipped",
    }),
  );

  const canonicalWithoutHash = {
    id: adapterOptions.id,
    version: adapterOptions.version,
    name: source.skill_name,
    description: source.description,
    matchers: [],
    assertions: source.criteria.map((criterion) => ({
      class: "j-rig-criterion",
      target: criterionTarget(criterion),
      extension: true,
    })),
    scoring: {
      // The canonical rule is deliberately a neutral projection. J-Rig's
      // criterion-level blocker and scoring semantics remain in the extension
      // and lineage until a consumer maps them to a rollout policy.
      aggregation_rule: "majority" as const,
      extensions: {
        "j-rig-skill-eval": {
          adapter_revision: SKILL_EVAL_SPEC_MAPPING_REVISION,
          mapping_revision: adapterOptions.mapping_revision,
          kernel_version: SKILL_EVAL_SPEC_KERNEL_VERSION,
          source_profile_hash: sourceProfileHash,
          source_profile_version: source.spec_version,
          models: source.models,
          ...(source.samples === undefined ? {} : { samples: source.samples }),
          ...(source.judge_temperature === undefined
            ? {}
            : { judge_temperature: source.judge_temperature }),
          ...(source.judge_timeout_ms === undefined
            ? {}
            : { judge_timeout_ms: source.judge_timeout_ms }),
          ...(source.judge_sample_concurrency === undefined
            ? {}
            : { judge_sample_concurrency: source.judge_sample_concurrency }),
          ...(source.execution_temperature === undefined
            ? {}
            : { execution_temperature: source.execution_temperature }),
          ...(source.min_blocker_agreement === undefined
            ? {}
            : { min_blocker_agreement: source.min_blocker_agreement }),
          ...(source.self_test === undefined ? {} : { self_test: source.self_test }),
          ...(source.siblings === undefined ? {} : { siblings: source.siblings }),
          ...(source.tags === undefined ? {} : { tags: source.tags }),
          test_case_coverage: testCaseCoverage,
        },
      },
    },
    composition: { nodes: [], edges: [] },
    expected_artifacts: adapterOptions.expected_artifacts,
    runtime_limits: adapterOptions.runtime_limits,
    provider_constraints: adapterOptions.provider_constraints,
    created_at: adapterOptions.created_at,
    created_by: adapterOptions.created_by,
  };

  const canonicalCandidate = {
    ...canonicalWithoutHash,
    content_hash: sha256(canonicalJson(canonicalWithoutHash)),
  };
  const parsedCanonical = EvalSpecSchema.safeParse(canonicalCandidate);
  if (!parsedCanonical.success) {
    throw new SkillEvalSpecAdapterError(
      "Canonical EvalSpec validation failed; no result was returned",
      issuesFrom(parsedCanonical),
    );
  }

  const canonical = parsedCanonical.data;
  return {
    canonical,
    lineage: {
      adapter_revision: SKILL_EVAL_SPEC_MAPPING_REVISION,
      mapping_revision: adapterOptions.mapping_revision,
      kernel_version: SKILL_EVAL_SPEC_KERNEL_VERSION,
      source_profile_hash: sourceProfileHash,
      source_profile_version: source.spec_version,
      source_skill_name: source.skill_name,
      canonical_spec_hash: canonical.content_hash,
      criterion_mappings: criterionMappings,
      test_case_coverage: testCaseCoverage,
      coverage: {
        evaluated_criterion_ids: allCriterionIds.filter((id) => evaluatedCriterionIds.has(id)),
        skipped_criterion_ids: skippedCriterionIds,
        evaluated_test_case_ids: testCaseCoverage
          .filter((testCase) => testCase.coverage === "evaluated")
          .map((testCase) => testCase.source_id),
        skipped_test_case_ids: testCaseCoverage
          .filter((testCase) => testCase.coverage === "skipped")
          .map((testCase) => testCase.source_id),
      },
    },
  };
}
