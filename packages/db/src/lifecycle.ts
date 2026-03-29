import type { RunStatus } from "./schema.js";

/**
 * Valid run status transitions.
 * Each key is the current status, values are allowed next statuses.
 */
const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ["running", "canceled"],
  running: ["completed", "failed", "timed_out", "canceled"],
  completed: [],
  failed: [],
  timed_out: [],
  canceled: [],
};

/**
 * Check if a status transition is valid.
 */
export function isValidTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Check if a status is terminal (no further transitions allowed).
 */
export function isTerminal(status: RunStatus): boolean {
  return TRANSITIONS[status]?.length === 0;
}

/**
 * Get the allowed next statuses from the current status.
 */
export function allowedTransitions(status: RunStatus): RunStatus[] {
  return TRANSITIONS[status] ?? [];
}

/**
 * All valid run statuses.
 */
export const ALL_STATUSES: RunStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "timed_out",
  "canceled",
];
