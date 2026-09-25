import type { GradeSelector, UnifiedReport } from "@j-rig/core";
import { buildUnifiedReport } from "@j-rig/core";
import type { JRigDatabase } from "./database.js";
import { getGradeObservations } from "./sampling.js";

/** Build a unified report over one explicitly selected immutable Grader. */
export function getUnifiedReport(
  database: JRigDatabase,
  selector: GradeSelector,
  generatedAt: string,
  rawRunIds?: readonly string[],
): UnifiedReport {
  return buildUnifiedReport({
    observations: getGradeObservations(database, selector, rawRunIds),
    selector,
    generated_at: generatedAt,
  });
}
