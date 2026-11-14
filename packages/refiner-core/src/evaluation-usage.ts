import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Evaluator token contract shared by the private engine and public Refiner. */
export const EvaluationTokenUsageSchema = z
  .object({
    inputTokens: count,
    outputTokens: count,
    cachedInputTokens: count.optional(),
    cacheCreationInputTokens: count.optional(),
    cacheCreation5mInputTokens: count.optional(),
    cacheCreation1hInputTokens: count.optional(),
  })
  .strict()
  .superRefine((usage, ctx) => {
    const cached = usage.cachedInputTokens ?? 0;
    const written = usage.cacheCreationInputTokens ?? 0;
    if (
      !Number.isSafeInteger(usage.inputTokens + usage.outputTokens) ||
      cached + written > usage.inputTokens
    )
      ctx.addIssue({ code: "custom", message: "Invalid token total or cache subsets" });
    if (
      (usage.cacheCreation5mInputTokens !== undefined ||
        usage.cacheCreation1hInputTokens !== undefined) &&
      (usage.cacheCreation5mInputTokens === undefined ||
        usage.cacheCreation1hInputTokens === undefined ||
        usage.cacheCreation5mInputTokens + usage.cacheCreation1hInputTokens !== written)
    )
      ctx.addIssue({ code: "custom", message: "Inconsistent cache creation TTL counts" });
  });
export type EvaluationTokenUsage = z.infer<typeof EvaluationTokenUsageSchema>;

export const EvaluationCallSchema = z
  .object({
    sequence: count,
    phase: z.enum(["trigger", "execution", "judge"]),
    provider: z.string().min(1),
    requestedModel: z.string().min(1),
    reportedModel: z.string().min(1).nullable(),
    outcome: z.enum(["completed", "failed", "interrupted"]),
    usage: EvaluationTokenUsageSchema.nullable(),
  })
  .strict();
export type EvaluationCall = z.infer<typeof EvaluationCallSchema>;

export const EvaluationUsageEvidenceSchema = z
  .object({
    schema: z.literal("evaluation-usage/v1"),
    calls: z.array(EvaluationCallSchema),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.calls.some((call, index) => call.sequence !== index))
      ctx.addIssue({ code: "custom", message: "Call sequence must be contiguous" });
  });
export type EvaluationUsageEvidence = z.infer<typeof EvaluationUsageEvidenceSchema>;
