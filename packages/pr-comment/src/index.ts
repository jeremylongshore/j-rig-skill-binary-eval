/**
 * @j-rig/pr-comment — pure, idempotent renderer that turns a rollout-gate
 * decision into a marker-anchored markdown PR comment block.
 *
 * Pair with `@intentsolutions/rollout-gate`: feed `decide()`'s result straight
 * into `renderPrComment()`, then have the host find-or-create the single
 * marker-anchored comment via `findCommentWithMarker()` so re-runs update the
 * existing comment in place instead of stacking duplicates.
 */
export {
  renderPrComment,
  openMarker,
  closeMarker,
  hasMarker,
  findCommentWithMarker,
  type RenderableDecision,
  type RenderRow,
  type RenderRequiredGate,
  type RenderOptions,
} from "./render.js";
