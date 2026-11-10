import type { EvalSet } from "./types.js";

/** Reviewed declarations, separate from the historical EvalSet hash preimage. */
export interface CapabilityManifest {
  readonly skillId: string;
  readonly evalSetHash: string;
  readonly capabilities: readonly { readonly id: string; readonly minimumItems: number }[];
  readonly assignments: readonly {
    readonly itemId: string;
    readonly capabilityIds: readonly string[];
  }[];
}

export interface CapabilityCoverageResult {
  /** Fraction of declared strata meeting their explicit sampling requirement. */
  readonly completeness: number;
  readonly complete: boolean;
  readonly strata: readonly {
    readonly id: string;
    readonly required: number;
    readonly observed: number;
    readonly missing: number;
  }[];
  readonly unassignedItemIds: readonly string[];
}

/**
 * Measure declared-capability sampling completeness, including absent strata.
 * A balanced observed distribution alone cannot prove capability coverage.
 * Assignments are reviewed evidence, not inferred from names or prompt text.
 * Throws on ambiguous/foreign declarations; returns incomplete for missing data.
 * This validates binding labels; callers must also verify EvalSet content hashes.
 */
export function capabilityCoverage(
  evalSet: EvalSet,
  manifest: CapabilityManifest,
): CapabilityCoverageResult {
  if (manifest.skillId !== evalSet.skillId || manifest.evalSetHash !== evalSet.hash) {
    throw new RangeError("capability manifest does not match the frozen eval set");
  }
  if (manifest.capabilities.length === 0) {
    throw new RangeError("declare at least one skill capability");
  }
  const counts = new Map<string, number>();
  for (const capability of manifest.capabilities) {
    if (
      !capability.id.trim() ||
      counts.has(capability.id) ||
      !Number.isSafeInteger(capability.minimumItems) ||
      capability.minimumItems < 1
    ) {
      throw new RangeError(
        "capabilities need unique nonempty ids and positive sampling requirements",
      );
    }
    counts.set(capability.id, 0);
  }
  const itemIds = new Set(evalSet.items.map((item) => item.id));
  if (itemIds.size !== evalSet.items.length) {
    throw new RangeError("eval-set item ids must be unique");
  }
  const assigned = new Set<string>();
  for (const assignment of manifest.assignments) {
    if (!itemIds.has(assignment.itemId) || assigned.has(assignment.itemId)) {
      throw new RangeError("capability assignments need unique known item ids");
    }
    const capabilities = new Set(assignment.capabilityIds);
    if (capabilities.size === 0 || capabilities.size !== assignment.capabilityIds.length) {
      throw new RangeError("assign each item to distinct declared capabilities");
    }
    for (const id of capabilities) {
      const count = counts.get(id);
      if (count === undefined) throw new RangeError("assignment names an undeclared capability");
      counts.set(id, count + 1);
    }
    assigned.add(assignment.itemId);
  }
  const strata = manifest.capabilities.map(({ id, minimumItems }) => {
    const observed = counts.get(id)!;
    return { id, required: minimumItems, observed, missing: Math.max(0, minimumItems - observed) };
  });
  const completeness = strata.filter((stratum) => stratum.missing === 0).length / strata.length;
  const unassignedItemIds = evalSet.items
    .filter((item) => !assigned.has(item.id))
    .map((item) => item.id);
  return {
    completeness,
    complete: completeness === 1 && unassignedItemIds.length === 0,
    strata,
    unassignedItemIds,
  };
}
