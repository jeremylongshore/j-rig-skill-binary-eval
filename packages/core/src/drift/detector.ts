import type { JudgmentResult } from "../judgment/types.js";
import type { DriftReport, DriftTrigger } from "./types.js";

/**
 * Detect drift between two evaluation runs.
 *
 * Drift occurs when a criterion that previously passed now fails
 * (or vice versa) without an intentional skill change.
 * This is distinct from regression — drift is detected during
 * scheduled reevaluation, not during a skill change.
 */
export function detectDrift(
  skillName: string,
  trigger: DriftTrigger,
  previousResults: JudgmentResult[],
  currentResults: JudgmentResult[],
  previousRunId?: number,
  currentRunId?: number,
): DriftReport {
  const prevMap = new Map(previousResults.map((r) => [r.criterion_id, r]));
  const driftedCriteria: string[] = [];

  for (const current of currentResults) {
    const prev = prevMap.get(current.criterion_id);
    if (!prev) continue;

    if (prev.verdict !== current.verdict) {
      driftedCriteria.push(current.criterion_id);
    }
  }

  return {
    skill_name: skillName,
    trigger,
    previous_run_id: previousRunId ?? null,
    current_run_id: currentRunId ?? null,
    drifted_criteria: driftedCriteria,
    drift_detected: driftedCriteria.length > 0,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check if a skill needs reevaluation based on its last run age.
 */
export function needsReevaluation(lastRunTimestamp: string, maxAgeDays: number = 30): boolean {
  const lastRun = new Date(lastRunTimestamp);
  const now = new Date();
  const ageMs = now.getTime() - lastRun.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > maxAgeDays;
}
