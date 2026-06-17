/**
 * SkillOptStyleStrategy — the original v4.1 propose() mechanism, refactored as a
 * strategy impl (DR-028 P0-RATIFY-5 / AC-13).
 *
 * SkillOpt-style (arXiv 2605.23904): rather than dropping the whole doc in
 * blind, this strategy locates the LOWEST-scoring rollouts (the "gradient
 * signal"), feeds the model the doc PLUS those failing transcripts, and asks for
 * bounded edits targeted at the observed failures. This is the text-space SGD
 * analog — edits are informed by where the skill empirically underperformed.
 *
 * Like the naive strategy, the model is injected so the mechanism (worst-rollout
 * selection, prompt assembly, op parsing) is pure + unit-testable.
 */

import type { EditProposal } from "../types.js";
import type { RefinerStrategy, ProposeContext, ScoredRollout } from "./types.js";
import { parseProposalResponse } from "./ops.js";
import { BEHAVIORAL_DIMENSION } from "../types.js";

export const SKILL_OPT_STYLE_STRATEGY_ID = "skill-opt-style/v1";

/** How many of the worst-scoring rollouts to feed the model as gradient signal. */
const WORST_K = 3;

/** Sort rollouts ascending by behavioral score, take the K weakest. */
export function selectWorstRollouts(
  rollouts: readonly ScoredRollout[],
  k: number = WORST_K,
): ScoredRollout[] {
  return [...rollouts]
    .sort(
      (a, b) =>
        a.score.dimensions[BEHAVIORAL_DIMENSION].value -
        b.score.dimensions[BEHAVIORAL_DIMENSION].value,
    )
    .slice(0, Math.max(0, k));
}

function buildPrompt(skillText: string, worst: readonly ScoredRollout[]): string {
  const failures = worst
    .map(
      (r, i) =>
        `Failing rollout ${i + 1} (item ${r.evalItemId}, behavioral=${r.score.dimensions[BEHAVIORAL_DIMENSION].value.toFixed(3)}):\n${r.transcript}`,
    )
    .join("\n\n");
  return [
    "You are refining a Claude Code SKILL.md using empirical failure signal.",
    "Below are the WEAKEST rollouts of this skill against its eval set. Propose a",
    "MINIMAL, bounded set of edits TARGETED at fixing the observed failures, without",
    "changing the skill's purpose. Respond ONLY with a JSON object of the form:",
    '{"rationale": "<why, referencing the failures>", "ops": [{"kind":"replace","target":"<exact substring>","content":"<text>"}]}',
    "Valid op kinds: add (after an exact substring), delete (an exact substring),",
    "replace (an exact substring with new content). Anchors must be exact, unique",
    "substrings of the document.",
    "",
    "--- SKILL.md ---",
    skillText,
    "--- failing rollouts ---",
    failures || "(no failing rollouts supplied)",
    "--- end ---",
  ].join("\n");
}

export class SkillOptStyleStrategy implements RefinerStrategy {
  readonly id = SKILL_OPT_STYLE_STRATEGY_ID;
  readonly description =
    "Worst-rollout-targeted bounded edits (text-space SGD analog, after SkillOpt arXiv 2605.23904).";

  async propose(ctx: ProposeContext): Promise<EditProposal> {
    const worst = selectWorstRollouts(ctx.rollouts);
    const prompt = buildPrompt(ctx.doc.text, worst);
    const completion = await ctx.model.complete(prompt);
    const { rationale, ops } = parseProposalResponse(completion);
    return {
      parent: ctx.doc.hash,
      ops,
      refinerModel: ctx.model.id,
      refinerStrategyId: this.id,
      rationale,
    };
  }
}
