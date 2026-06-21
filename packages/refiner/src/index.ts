/**
 * @intentsolutions/refiner — Skill Refiner orchestrator + I/O adapters + CLI (Phase A,
 * wave 2). Depends on the pure foundation `@intentsolutions/refiner-core` (wave 1).
 *
 * This package supplies the I/O half of the value-oriented Refiner discipline:
 *   - PERSISTENCE (build-order step 4): content-addressed store + append-only
 *     event log + single mutable best-pointer. See {@link RefinerStore}.
 *   - score() ADAPTER (step 5): delegate to the existing `j-rig eval` via an
 *     injectable shell-out, map its output → a refiner-core ScoreRecord. See
 *     {@link score}.
 *   - propose() ADAPTER (step 6): an injectable, tiered (haiku|sonnet, NEVER
 *     opus per AC-5) Anthropic-backed RefinerModel wired to a refiner-core
 *     RefinerStrategy. See {@link propose} / {@link createRefinerModel}.
 *   - CLI (step 7): the 5 `j-rig refine <cmd>` commands. See {@link registerRefineCommand}.
 *
 * NOT in this wave (gated / later waves): the SkillVersion kernel entity, the
 * skill-refiner-pass/v1 predicate URI + signed evidence emission, the Claude Code
 * plugin + 3-layer hooks, and the synchronized npm release ceremony. See the PR
 * body's "Deferred / still-gated" section.
 *
 * Plan: intent-eval-lab/000-docs/027-PP-PLAN-skill-refiner-snoopy-fluttering-comet-v4-2026-05-26.md
 */

// Persistence (step 4)
export {
  RefinerStore,
  createNodeFileSystem,
  type FileSystem,
  type RefinerRecordKind,
  type RefinerEvent,
} from "./store.js";

// score() adapter (step 5)
export {
  score,
  createSubprocessEvalRunner,
  ScoreAdapterError,
  type ScoreModelTier,
  type EvalRunner,
  type EvalRunnerResult,
  type EvalInvocation,
  type ScoreOptions,
} from "./score.js";

// propose() adapter (step 6)
export {
  propose,
  createRefinerModel,
  resolveProposeModelId,
  assertNotOpus,
  AnthropicCompletionClient,
  ProposeAdapterError,
  type ProposeModelTier,
  type CompletionClient,
  type CompletionTransport,
  type ProposeModelOptions,
  type AnthropicCompletionClientOptions,
} from "./propose.js";

// CLI (step 7)
export { registerRefineCommand } from "./cli.js";
