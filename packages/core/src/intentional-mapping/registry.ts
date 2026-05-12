/**
 * MM-N registry — a lookup from MMCategory → checker function.
 *
 * Each MM-N category lives in its own mm-N-name.ts file and exports a
 * checker. The registry pins which checker handles which category. This
 * keeps the registry the single point of dispatch when the eval pipeline
 * walks a fixture or a live trace.
 *
 * As MM-2..MM-6 implementations land in subsequent PRs, they register here.
 */
import type { MMCategory, MMChecker, MMResult, TraceEvent } from "./types.js";
import { checkMM1AsyncRace } from "./mm-1-async-race.js";
import { checkMM2ShapeDrift } from "./mm-2-shape-drift.js";
import { checkMM3Cooldown } from "./mm-3-cooldown.js";
import { checkMM4SideEffectVerification } from "./mm-4-side-effect-verification.js";
import { checkMM5ContextAugmentation } from "./mm-5-context-augmentation.js";
import { checkMM6StrictModeProtocol } from "./mm-6-strict-mode-protocol.js";

/**
 * Registered checkers by MM category. Categories without an implementation
 * are absent from the map; calls to runChecker for an unregistered category
 * return a conservative NOT_APPLICABLE-with-note rather than throw — partial
 * coverage is explicitly valid per the Evidence Bundle SPEC § R2.
 */
export const MM_CHECKERS: Partial<Record<MMCategory, MMChecker>> = {
  "MM-1": checkMM1AsyncRace,
  "MM-2": checkMM2ShapeDrift,
  "MM-3": checkMM3Cooldown,
  "MM-4": checkMM4SideEffectVerification,
  "MM-5": checkMM5ContextAugmentation,
  "MM-6": checkMM6StrictModeProtocol,
};

/**
 * Run the registered checker for a category against a trace. Returns
 * NOT_APPLICABLE with a clear note when no checker is registered (so the
 * eval pipeline can include the row in the Evidence Bundle without lying
 * about what was evaluated).
 */
export function runChecker(category: MMCategory, events: TraceEvent[]): MMResult {
  const checker = MM_CHECKERS[category];
  if (!checker) {
    return {
      category,
      result: "NOT_APPLICABLE",
      reason: `no checker registered for ${category} at this version of @j-rig/core (partial coverage is valid per Evidence Bundle SPEC § R2)`,
    };
  }
  return checker(events);
}

/** Run every registered checker; returns one result per registered category. */
export function runAllRegisteredCheckers(events: TraceEvent[]): MMResult[] {
  return (Object.entries(MM_CHECKERS) as Array<[MMCategory, MMChecker]>).map(([, fn]) =>
    fn(events),
  );
}
