import type { Criterion, JudgmentResult, ScoreCard, SkillEvalSpec } from "@j-rig/core";

export interface VoteEvidenceInput {
  allJudgments: readonly JudgmentResult[];
  scoringCriteria: readonly Pick<Criterion, "id" | "blocker">[];
  spec: Pick<SkillEvalSpec, "min_blocker_agreement">;
  judgeSamples: number | undefined;
  scoreCard: Pick<ScoreCard, "unstable_blocker_failures">;
}

/** Preserve the recorded fold inputs and optional-field presence in bundle metadata. */
export function buildVoteEvidence({
  allJudgments,
  scoringCriteria,
  spec,
  judgeSamples,
  scoreCard,
}: VoteEvidenceInput) {
  const criteriaById = new Map(scoringCriteria.map((c) => [c.id, c]));
  const multiSampled = allJudgments.some((j) => (j.samples ?? 1) >= 2);
  const voteEvidence = {
    aggregation: {
      rule: "majority-vote",
      denominator_rule: "errored-samples-count-as-unsure",
      blocker_quorum: spec.min_blocker_agreement ?? null,
      samples_default: judgeSamples ?? 1,
    },
    criteria: allJudgments.map((j) => ({
      criterion_id: j.criterion_id,
      ...(j.test_case_id !== undefined ? { test_case_id: j.test_case_id } : {}),
      blocker: criteriaById.get(j.criterion_id)?.blocker ?? false,
      method: j.method,
      verdict: j.verdict,
      ...(j.samples !== undefined ? { samples: j.samples } : {}),
      ...(j.agreement !== undefined ? { agreement: j.agreement } : {}),
      ...(j.sample_verdicts !== undefined ? { sample_verdicts: j.sample_verdicts } : {}),
      // Aligned index-for-index with sample_verdicts: the timing
      // signal an auditor needs to discount correlated votes.
      ...(j.sample_latencies_ms !== undefined
        ? { sample_latencies_ms: j.sample_latencies_ms }
        : {}),
    })),
    ...(multiSampled
      ? {
          stability: {
            min_blocker_agreement: spec.min_blocker_agreement ?? null,
            unstable_blocker_failures: scoreCard.unstable_blocker_failures ?? 0,
          },
        }
      : {}),
  };

  return voteEvidence;
}
