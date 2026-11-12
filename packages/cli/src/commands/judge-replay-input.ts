import { createHash } from "node:crypto";
import { CriterionSchema, type GoldenCase } from "@j-rig/core";
import { z } from "zod";
import { parseDocument } from "yaml";
import { requestPacingPolicy } from "../providers/request-pacing.js";

const text = z.string().refine((value) => value.trim().length > 0, "Nonempty text required");
const digest = z.string().regex(/^sha256:[a-f0-9]{64}(?![\s\S])/);

// Local unsigned input documents, not a new kernel or evidence-bundle contract.
const CorpusSchema = z
  .object({
    schema: z.literal("j-rig/judge-replay-corpus/v1"),
    source: z.object({ revision: text, artifact_sha256: digest }).strict(),
    rows: z
      .array(
        z
          .object({
            id: text,
            criterion: z
              .object({ id: text, description: text, judge_prompt: text.optional() })
              .strict(),
            prompt: text,
            output: z.string(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

const ReviewSchema = z
  .object({
    schema: z.literal("j-rig/judge-replay-review/v1"),
    corpus_sha256: digest,
    reviewer: text,
    reviewed_at: z.string().datetime({ offset: true }),
    reviewed: z.literal(true),
    labels: z
      .array(
        z
          .object({
            id: text,
            expected_verdict: z.enum(["yes", "no"]),
            rationale: text,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

export const ReplayPolicySchema = z
  .object({
    provider: z.enum(["deepseek", "groq", "nvidia"]),
    model: text,
    samples: z.number().int().min(1).max(25),
    repeats: z.number().int().min(1).max(100),
    temperature: z.number().min(0).max(2),
    requests_per_minute: z.number().int().min(1).max(60_000),
    judge_timeout_ms: z.number().int().min(1).max(120_000),
    max_wall_ms: z.number().int().min(1).max(86_400_000),
    max_calls: z.number().int().min(1).max(10_000),
  })
  .strict();

export function replayDigest(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function parseReplayJson(bytes: string): unknown {
  const value: unknown = JSON.parse(bytes);
  if (parseDocument(bytes, { uniqueKeys: true }).errors.length) {
    throw new Error("Replay JSON has duplicate or unsupported keys");
  }
  return value;
}

/** Hash exact submitted bytes; provenance is an explicit human attestation, not a signature. */
export function admitReplay(
  corpusBytes: string,
  reviewBytes: string,
  policyInput: unknown,
  now: Date,
) {
  for (const bytes of [corpusBytes, reviewBytes]) {
    if (Buffer.byteLength(bytes, "utf8") > 4 * 1024 * 1024) {
      throw new Error("Judge replay document exceeds 4 MiB");
    }
  }
  const corpus = CorpusSchema.parse(parseReplayJson(corpusBytes));
  const review = ReviewSchema.parse(parseReplayJson(reviewBytes));
  const policy = ReplayPolicySchema.parse(policyInput);
  const corpusHash = replayDigest(corpusBytes);
  if (review.corpus_sha256 !== corpusHash) throw new Error("Review does not bind corpus bytes");
  if (!Number.isFinite(now.getTime()) || Date.parse(review.reviewed_at) > now.getTime()) {
    throw new Error("Review time is invalid or in the future");
  }
  const ids = new Set(corpus.rows.map((row) => row.id));
  const labels = new Map(review.labels.map((label) => [label.id, label]));
  if (ids.size !== corpus.rows.length || labels.size !== review.labels.length) {
    throw new Error("Duplicate replay row or review label");
  }
  if (labels.size !== ids.size || [...labels.keys()].some((id) => !ids.has(id))) {
    throw new Error("Review must label every corpus row exactly once");
  }
  const plannedCalls = corpus.rows.length * policy.samples * policy.repeats;
  if (plannedCalls > policy.max_calls) throw new Error("Planned replay exceeds call limit");
  const rows = corpus.rows.map((row) => {
    const label = labels.get(row.id)!;
    const criterion = CriterionSchema.parse({ ...row.criterion, method: "judge" });
    const golden: GoldenCase = {
      criterion_id: criterion.id,
      prompt: row.prompt,
      output: row.output,
      explanation: criterion.description,
      expected_verdict: label.expected_verdict,
    };
    return { id: row.id, criterion, golden, rationale: label.rationale };
  });
  return {
    corpus,
    review,
    policy,
    rows,
    corpusHash,
    reviewHash: replayDigest(reviewBytes),
    policyHash: replayDigest(JSON.stringify(policy)),
    pacing: requestPacingPolicy(String(policy.requests_per_minute))!,
    plannedCalls,
  };
}
export type AdmittedReplay = ReturnType<typeof admitReplay>;
