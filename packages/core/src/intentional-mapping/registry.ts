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

/**
 * Registered checkers by MM category. Categories without an implementation
 * are absent from the map; calls to runChecker("MM-2") will return a
 * conservative NOT_APPLICABLE-with-note rather than throw — partial
 * coverage is explicitly valid per the Evidence Bundle SPEC § R2.
 */
export const MM_CHECKERS: Partial<Record<MMCategory, MMChecker>> = {
  "MM-1": checkMM1AsyncRace,
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
