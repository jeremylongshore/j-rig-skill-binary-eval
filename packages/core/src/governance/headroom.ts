import { wilsonInterval, type WilsonInterval } from "../sampling/substrate.js";

/**
 * Runtime default for the saturation ceiling, applied only when the eval spec
 * does not declare `headroom_ceiling`. It lives here, not as a schema default:
 * a schema default would rewrite every parsed spec and change its snapshot.
 */
export const DEFAULT_HEADROOM_CEILING = 0.95;

/**
 * - `saturated`: the observed pass rate is at or above the ceiling. The eval
 *   can no longer show that a change helped.
 * - `near_ceiling`: below the ceiling, but the 95% Wilson interval reaches it,
 *   so saturation cannot be ruled out at this sample size.
 * - `headroom`: the whole interval sits below the ceiling.
 * - `no_data`: nothing was scored.
 */
export type HeadroomStatus = "saturated" | "near_ceiling" | "headroom" | "no_data";

export interface HeadroomAssessment {
  status: HeadroomStatus;
  ceiling: number;
  ceiling_source: "spec" | "default";
  passed: number;
  trials: number;
  pass_rate: number | null;
  confidence_interval_95: WilsonInterval | null;
}

export interface HeadroomInput {
  passed: number;
  trials: number;
  /** The spec's `headroom_ceiling`; omitted means the runtime default. */
  ceiling?: number;
}

/**
 * Say whether an eval still has room to measure improvement. This is a
 * measurement of the eval, not a verdict on the skill: it never changes the
 * rollout decision and is reported beside pass/fail, never inside it.
 */
export function assessHeadroom(input: HeadroomInput): HeadroomAssessment {
  const ceiling = input.ceiling ?? DEFAULT_HEADROOM_CEILING;
  if (!(ceiling > 0 && ceiling <= 1)) {
    throw new Error(`headroom ceiling must be in (0, 1], got ${ceiling}`);
  }
  const interval = wilsonInterval(input.passed, input.trials);
  const pass_rate = input.trials === 0 ? null : input.passed / input.trials;

  let status: HeadroomStatus;
  if (pass_rate === null || interval === null) status = "no_data";
  else if (pass_rate >= ceiling) status = "saturated";
  else if (interval.upper >= ceiling) status = "near_ceiling";
  else status = "headroom";

  return {
    status,
    ceiling,
    ceiling_source: input.ceiling === undefined ? "default" : "spec",
    passed: input.passed,
    trials: input.trials,
    pass_rate,
    confidence_interval_95: interval,
  };
}
