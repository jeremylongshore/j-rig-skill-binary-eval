/**
 * NaiveInContextStrategy — the null-hypothesis baseline (DR-028 P0-RATIFY-3/5).
 *
 * Single-pass: drop the WHOLE skill doc into the model context, ask for a minimal
 * improvement, take whatever bounded ops come back. No scored-rollout analysis,
 * no targeted prompting, no iteration. This is deliberately the dumbest thing
 * that could work — it doubles as the Phase A.0 baseline the proposed mechanism
 * must beat by > 70% of projected lift or Phase B descopes.
 *
 * The model is injected (see RefinerModel), so this is pure + unit-testable with
 * a stub completion.
 */

import type { EditProposal } from "../types.js";
import type { RefinerStrategy, ProposeContext } from "./types.js";
import { parseProposalResponse } from "./ops.js";

export const NAIVE_IN_CONTEXT_STRATEGY_ID = "naive-in-context/v1";

const PROMPT_TEMPLATE = (skillText: string): string =>
  [
    "You are refining a Claude Code SKILL.md. Propose a MINIMAL, bounded set of",
    "edits that improves the skill without changing its purpose. Respond ONLY with",
    "a JSON object of the form:",
    '{"rationale": "<why>", "ops": [{"kind":"add","after":"<exact substring>","content":"<text>"}]}',
    "Valid op kinds: add (after an exact substring), delete (an exact substring),",
    "replace (an exact substring with new content). Anchors must be exact, unique",
    "substrings of the document. Keep edits small.",
    "",
    "--- SKILL.md ---",
    skillText,
    "--- end ---",
  ].join("\n");

export class NaiveInContextStrategy implements RefinerStrategy {
  readonly id = NAIVE_IN_CONTEXT_STRATEGY_ID;
  readonly description =
    "Single-pass whole-document in-context proposal; the Phase A.0 null-hypothesis baseline.";

  async propose(ctx: ProposeContext): Promise<EditProposal> {
    const prompt = PROMPT_TEMPLATE(ctx.doc.text);
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
