/**
 * RefinerStrategy interface (AC-13 / DR-028 P0-RATIFY-5).
 *
 * The Refiner MECHANISM is swappable; the acceptance GATE is the durable
 * contribution (AC-7 bitter-lesson hedge). A strategy is the thing that, given a
 * skill doc + the scored rollouts of that doc against an eval set, PROPOSES a
 * bounded edit (the `propose()` operation of plan 027 § 4). Different strategies
 * embody different propose() mechanisms; the gate downstream is identical.
 *
 * To keep strategies UNIT-TESTABLE as pure code, the model call is INJECTED as a
 * `RefinerModel` rather than baked in. A real adapter wraps the Anthropic SDK
 * (wave 2+); tests pass a deterministic stub. The strategy itself contains the
 * mechanism logic (prompt assembly, op extraction, bounds enforcement), which is
 * what we want to test.
 *
 * Per CISO binding: every strategy has a stable `id`, recorded on the
 * EditProposal (`refinerStrategyId`) and signed in the predicate payload, so a
 * swappable mechanism never becomes an untraceable one.
 */

import type { SkillDoc, ScoreRecord, EditProposal, RefinerStrategyId } from "../types.js";

/**
 * A scored rollout: one ScoreRecord plus the verbatim transcript text that
 * produced it (so a strategy can reason about WHERE the skill underperformed).
 */
export interface ScoredRollout {
  readonly score: ScoreRecord;
  /** Eval item id this rollout exercised. */
  readonly evalItemId: string;
  /** Verbatim model output for this rollout (input to propose reasoning). */
  readonly transcript: string;
}

/** A single model completion: prompt in, text out. Injected, so it's stubbable. */
export interface RefinerModel {
  /** Stable model identifier recorded on the proposal (e.g. "claude-sonnet"). */
  readonly id: string;
  /** Produce a completion for the given prompt. */
  complete(prompt: string): Promise<string>;
}

/** Context handed to a strategy when asked to propose an edit. */
export interface ProposeContext {
  readonly doc: SkillDoc;
  readonly rollouts: readonly ScoredRollout[];
  readonly model: RefinerModel;
}

/**
 * The swappable Refiner mechanism. An implementation embodies one `propose()`
 * strategy. It MUST return a proposal whose `parent === ctx.doc.hash` and whose
 * `refinerStrategyId === this.id` (enforced by the conformance suite).
 */
export interface RefinerStrategy {
  /** Stable, signable identifier for this strategy. */
  readonly id: RefinerStrategyId;
  /** Human-readable description (surfaced in the Evidence Report). */
  readonly description: string;
  /** Propose a bounded edit given the doc + its scored rollouts. */
  propose(ctx: ProposeContext): Promise<EditProposal>;
}
