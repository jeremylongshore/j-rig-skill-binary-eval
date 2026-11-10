import { z } from "zod";
import { EvaluationTokenUsageSchema, type EvaluationTokenUsage } from "./evaluation-usage.js";

const count = z.number().int().nonnegative().safe();
const identity = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s.trim() === s);
const rates = z
  .object({
    input: count,
    output: count,
    cacheRead: count,
    cacheWrite: count,
    cacheWrite5m: count,
    cacheWrite1h: count,
  })
  .strict();
export const CostRateSchema = z
  .object({
    provider: identity,
    model: identity,
    reportedModels: z
      .array(identity)
      .min(1)
      .refine((models) => new Set(models).size === models.length),
    format: z.enum(["anthropic", "openai"]),
    // These are operator-reviewed provider limits, not observed token estimates.
    maxInputTokens: count.positive(),
    maxOutputTokens: count.positive(),
    protocolOverheadTokens: count,
    microsPerMillionTokens: rates,
  })
  .strict();
export const CostPolicySchema = z
  .object({
    schema: z.literal("refiner-cost-policy/v1"),
    scopeId: identity,
    profile: z.enum(["custom", "wave-b"]),
    source: z.string().min(1).max(2048),
    files: z.array(identity).min(1),
    rates: z.array(CostRateSchema).min(1),
    maxFileMicros: count.positive(),
    maxTotalMicros: count.positive(),
    meanFileBudgetMicros: count.positive(),
    stopBasisPoints: count.positive().max(10000),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (BigInt(p.maxTotalMicros) * BigInt(p.stopBasisPoints) < 10000n)
      ctx.addIssue({ code: "custom", message: "Stop threshold must be at least one micro-USD" });
    if (
      new Set(p.files).size !== p.files.length ||
      new Set(p.rates.map((r) => JSON.stringify([r.provider, r.model]))).size !== p.rates.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate file or rate identity" });
    if (
      p.profile === "wave-b" &&
      (p.maxFileMicros !== 200_000_000 ||
        p.maxTotalMicros !== 35_000_000_000 ||
        p.meanFileBudgetMicros !== 50_000_000 ||
        p.stopBasisPoints !== 8000)
    )
      ctx.addIssue({
        code: "custom",
        message: "Wave B limits are fixed by Plan033 section14.4.cost",
      });
  });
export type CostPolicy = z.infer<typeof CostPolicySchema>;
export type CostRate = z.infer<typeof CostRateSchema>;
export function safeMicros(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Cost arithmetic overflow");
  return Number(value);
}
/** Integer micro-USD, rounded UP once per wire attempt; never floating-point admission. */
function charge(parts: Array<[number, number]>): number {
  const numerator = parts.reduce((sum, [tokens, rate]) => sum + BigInt(tokens) * BigInt(rate), 0n);
  return safeMicros((numerator + 999_999n) / 1_000_000n);
}
export function priceCostUsage(rate: CostRate, input: EvaluationTokenUsage): number {
  const r = CostRateSchema.parse(rate).microsPerMillionTokens;
  const u = EvaluationTokenUsageSchema.parse(input);
  const read = u.cachedInputTokens ?? 0;
  const write = u.cacheCreationInputTokens ?? 0;
  const parts: Array<[number, number]> = [
    [u.inputTokens - read - write, r.input],
    [u.outputTokens, r.output],
    [read, r.cacheRead],
  ];
  if (u.cacheCreation5mInputTokens !== undefined && u.cacheCreation1hInputTokens !== undefined)
    parts.push(
      [u.cacheCreation5mInputTokens, r.cacheWrite5m],
      [u.cacheCreation1hInputTokens, r.cacheWrite1h],
    );
  else parts.push([write, r.cacheWrite]);
  return charge(parts);
}
export function reserveCost(rate: CostRate, outputLimit: number): number {
  const r = CostRateSchema.parse(rate);
  count.positive().max(r.maxOutputTokens).parse(outputLimit);
  const prices = r.microsPerMillionTokens;
  return charge([
    [
      r.maxInputTokens,
      Math.max(
        prices.input,
        prices.cacheRead,
        prices.cacheWrite,
        prices.cacheWrite5m,
        prices.cacheWrite1h,
      ),
    ],
    [outputLimit, prices.output],
  ]);
}
export function costStopMicros(policy: CostPolicy): number {
  const p = CostPolicySchema.parse(policy);
  return safeMicros((BigInt(p.maxTotalMicros) * BigInt(p.stopBasisPoints)) / 10000n);
}
