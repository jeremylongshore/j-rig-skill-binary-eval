import { createHash } from "node:crypto";
import { z } from "zod";
import { EvalIdentifierSchema } from "../execution/substrate.js";
import type { ObservedOutcome } from "../execution/types.js";
import { judgeCriteria } from "../judgment/engine.js";
import type { JudgeProvider, JudgmentVerdict } from "../judgment/types.js";

/** Deterministic checks remain intentionally auditable and replayable. */
export const GraderCheckSchema = z.object({
  id: EvalIdentifierSchema,
  type: z.literal("output_contains"),
  expected: z.string().min(1),
  required: z.boolean().default(true),
});

export type GraderCheck = z.infer<typeof GraderCheckSchema>;

const DeterministicGraderDefinitionSchema = z.object({
  id: EvalIdentifierSchema,
  version: z.string().min(1),
  kind: z.literal("deterministic"),
  description: z.string().min(1).optional(),
  checks: z.array(GraderCheckSchema).min(1),
});

/** A model judge grader delegates one criterion to the shared judge engine. */
const ModelJudgeGraderDefinitionSchema = z.object({
  id: EvalIdentifierSchema,
  version: z.string().min(1),
  kind: z.literal("model_judge"),
  description: z.string().min(1).optional(),
  model: z.string().min(1),
  criterion_id: EvalIdentifierSchema.default("model-judge"),
  criterion_description: z.string().min(1),
  judge_prompt: z.string().min(1),
  samples: z.number().int().min(1).max(25).default(1),
  judge_temperature: z.number().min(0).max(2).optional(),
});

/** A named, versioned grader definition. The definition is the snapshot input. */
export const GraderDefinitionSchema = z.discriminatedUnion("kind", [
  DeterministicGraderDefinitionSchema,
  ModelJudgeGraderDefinitionSchema,
]);

export type GraderDefinition = z.infer<typeof GraderDefinitionSchema>;
export type DeterministicGraderDefinition = z.infer<typeof DeterministicGraderDefinitionSchema>;
export type ModelJudgeGraderDefinition = z.infer<typeof ModelJudgeGraderDefinitionSchema>;

export const GradeVerdictSchema = z.enum(["pass", "fail"]);
export type GradeVerdict = z.infer<typeof GradeVerdictSchema>;

export interface GraderCheckResult {
  id: string;
  type: "output_contains";
  expected: string;
  passed: boolean;
  required: boolean;
  details: string;
}

/** Vote-level evidence retained when a model judge is sampled. */
export interface JudgeGradeMetadata {
  judge_model: string;
  raw_verdict: JudgmentVerdict;
  samples: number;
  agreement: number;
  sample_verdicts: JudgmentVerdict[];
  sample_latencies_ms?: number[];
  disagreement: boolean;
  reasoning: string;
}

export interface GradeMetadata {
  judge?: JudgeGradeMetadata;
}

export interface GradeEvaluation {
  raw_run_id: string;
  grader_id: string;
  grader_version: string;
  grader_kind: GraderDefinition["kind"];
  grader_snapshot_json: string;
  grader_snapshot_sha256: string;
  verdict: GradeVerdict;
  score: number;
  checks: GraderCheckResult[];
  metadata?: GradeMetadata;
}

/** Serialize a parsed grader definition exactly as the Grade snapshot stores it. */
export function serializeGraderSnapshot(definition: GraderDefinition): string {
  return JSON.stringify(definition);
}

export function hashGraderSnapshot(definition: GraderDefinition): string {
  return `sha256:${createHash("sha256").update(serializeGraderSnapshot(definition)).digest("hex")}`;
}

/**
 * Evaluate one sealed raw stdout without mutating the Run.
 *
 * This is deliberately a deterministic checker. Model-judge Graders use the
 * same GradeEvaluation persistence boundary and retain their vote evidence
 * through evaluateWithModelJudge below.
 */
export function evaluateWithGrader(
  rawRunId: string,
  stdout: string,
  definition: DeterministicGraderDefinition,
): GradeEvaluation {
  const checks = definition.checks.map((check): GraderCheckResult => {
    const passed = stdout.includes(check.expected);
    return {
      id: check.id,
      type: check.type,
      expected: check.expected,
      passed,
      required: check.required,
      details: passed
        ? `stdout contains ${JSON.stringify(check.expected)}`
        : `stdout is missing ${JSON.stringify(check.expected)}`,
    };
  });

  const requiredChecks = checks.filter((check) => check.required);
  const verdict: GradeVerdict = requiredChecks.every((check) => check.passed) ? "pass" : "fail";
  const score = checks.filter((check) => check.passed).length / checks.length;

  return {
    raw_run_id: rawRunId,
    grader_id: definition.id,
    grader_version: definition.version,
    grader_kind: definition.kind,
    grader_snapshot_json: serializeGraderSnapshot(definition),
    grader_snapshot_sha256: hashGraderSnapshot(definition),
    verdict,
    score,
    checks,
  };
}

/**
 * Evaluate one sealed raw stdout through the shared model-judge engine.
 *
 * The Grade surface stays binary: `yes` becomes pass and both `no` and
 * `unsure` become fail-closed. The original verdict plus every sampled vote,
 * agreement fraction, latency, and reasoning remain in metadata so a report
 * can show disagreement instead of presenting a synthetic pass/fail as truth.
 */
export async function evaluateWithModelJudge(
  rawRunId: string,
  stdout: string,
  definition: ModelJudgeGraderDefinition,
  judgeProvider: JudgeProvider,
): Promise<GradeEvaluation> {
  const now = new Date().toISOString();
  const outcome: ObservedOutcome = {
    test_case_id: definition.criterion_id,
    prompt: definition.criterion_description,
    output: { text: stdout, artifacts: [], tool_calls: 0 },
    meta: {
      started_at: now,
      completed_at: now,
      duration_ms: 0,
      timed_out: false,
    },
    status: "completed",
  };
  const [judgment] = await judgeCriteria(
    [
      {
        id: definition.criterion_id,
        description: definition.criterion_description,
        method: "judge",
        blocker: false,
        regression_critical: false,
        baseline_sensitive: false,
        pack_sensitive: false,
        judge_prompt: definition.judge_prompt,
        samples: definition.samples,
        judge_temperature: definition.judge_temperature,
      },
    ],
    outcome,
    judgeProvider,
    { model: definition.model },
  );
  if (!judgment) throw new Error(`Model judge returned no result for ${definition.id}`);
  if (judgment.judge_error !== undefined) {
    // No judgment happened. Do not seal an infrastructure outage into an
    // immutable quality Grade or prevent a later retry with a healthy judge.
    throw new Error(`Model judge failed for ${definition.id}: ${judgment.judge_error}`);
  }

  const sampleVerdicts = judgment.sample_verdicts ?? [judgment.verdict];
  const agreement = judgment.agreement ?? (judgment.verdict === "unsure" ? 0 : judgment.confidence);
  const disagreement =
    judgment.verdict === "unsure" ||
    sampleVerdicts.some((verdict) => verdict !== sampleVerdicts[0]);

  return {
    raw_run_id: rawRunId,
    grader_id: definition.id,
    grader_version: definition.version,
    grader_kind: definition.kind,
    grader_snapshot_json: serializeGraderSnapshot(definition),
    grader_snapshot_sha256: hashGraderSnapshot(definition),
    verdict: judgment.verdict === "yes" ? "pass" : "fail",
    score: judgment.verdict === "yes" ? 1 : 0,
    checks: [],
    metadata: {
      judge: {
        judge_model: definition.model,
        raw_verdict: judgment.verdict,
        samples: judgment.samples ?? sampleVerdicts.length,
        agreement,
        sample_verdicts: sampleVerdicts,
        ...(judgment.sample_latencies_ms
          ? { sample_latencies_ms: judgment.sample_latencies_ms }
          : {}),
        disagreement,
        reasoning: judgment.reasoning,
      },
    },
  };
}
