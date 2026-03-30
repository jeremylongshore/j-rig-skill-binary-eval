export { buildRoster, formatRoster, type RosterEntry, type SkillRoster } from "./roster.js";
export { runTriggerTests } from "./runner.js";
export { computeMetrics, detectConfusion } from "./metrics.js";
export type {
  TriggerOutcome,
  TriggerResult,
  TriggerMetrics,
  ConfusionPair,
  TriggerProvider,
} from "./types.js";
