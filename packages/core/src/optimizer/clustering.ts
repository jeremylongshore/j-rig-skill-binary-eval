import type { JudgmentResult } from "../judgment/types.js";
import type { Criterion } from "../schemas/criterion.js";
import type { FailureCluster } from "./types.js";

/**
 * Cluster failures by pattern to identify the weakest areas.
 *
 * Groups failing criteria by method and blocker status,
 * then ranks by severity (blockers first, then by count).
 */
export function clusterFailures(
  results: JudgmentResult[],
  criteria: Criterion[],
): FailureCluster[] {
  const criteriaMap = new Map(criteria.map((c) => [c.id, c]));
  const failures = results.filter((r) => r.verdict === "no");

  if (failures.length === 0) return [];

  // Group by method
  const groups = new Map<string, JudgmentResult[]>();
  for (const f of failures) {
    const criterion = criteriaMap.get(f.criterion_id);
    const key = criterion?.method ?? "unknown";
    const group = groups.get(key) ?? [];
    group.push(f);
    groups.set(key, group);
  }

  const clusters: FailureCluster[] = [];

  for (const [method, group] of groups) {
    const hasBlocker = group.some((f) => {
      const c = criteriaMap.get(f.criterion_id);
      return c?.blocker ?? false;
    });

    clusters.push({
      pattern: `${method} failures`,
      criterion_ids: group.map((f) => f.criterion_id),
      count: group.length,
      severity: hasBlocker ? "critical" : group.length > 2 ? "high" : "medium",
    });
  }

  // Sort: critical first, then by count descending
  return clusters.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2 };
    const diff = severityOrder[a.severity] - severityOrder[b.severity];
    return diff !== 0 ? diff : b.count - a.count;
  });
}

/**
 * Select the weakest criterion — the best target for optimization.
 *
 * Priority: blocker failures > regression-critical failures > highest-count cluster
 */
export function selectWeakest(results: JudgmentResult[], criteria: Criterion[]): string | null {
  const criteriaMap = new Map(criteria.map((c) => [c.id, c]));
  const failures = results.filter((r) => r.verdict === "no");

  if (failures.length === 0) return null;

  // Priority 1: blocker failures
  const blockerFailure = failures.find((f) => criteriaMap.get(f.criterion_id)?.blocker);
  if (blockerFailure) return blockerFailure.criterion_id;

  // Priority 2: regression-critical failures
  const regressionFailure = failures.find(
    (f) => criteriaMap.get(f.criterion_id)?.regression_critical,
  );
  if (regressionFailure) return regressionFailure.criterion_id;

  // Priority 3: first failure
  return failures[0].criterion_id;
}
