import type { CheckResult } from "./types.js";

/**
 * A deterministic check function.
 * Takes input text and optional parameters, returns a boolean.
 */
export type DeterministicCheckFn = (input: string, params?: Record<string, unknown>) => boolean;

/**
 * Registry of reusable deterministic checks.
 *
 * These are non-LLM checks that can evaluate criteria cheaply.
 * Each check takes a string input and returns true if the check passes.
 */
const registry = new Map<string, DeterministicCheckFn>();

/**
 * Register a deterministic check.
 */
export function registerCheck(name: string, fn: DeterministicCheckFn): void {
  registry.set(name, fn);
}

/**
 * Run a named deterministic check.
 * Returns a CheckResult with pass/error severity.
 */
export function runCheck(
  checkName: string,
  input: string,
  params?: Record<string, unknown>,
): CheckResult {
  const fn = registry.get(checkName);
  if (!fn) {
    return {
      id: `deterministic:${checkName}`,
      description: `Deterministic check: ${checkName}`,
      severity: "error",
      message: `Unknown deterministic check: "${checkName}"`,
      details: `Available checks: ${[...registry.keys()].join(", ")}`,
    };
  }

  let passed: boolean;
  try {
    passed = fn(input, params);
  } catch (err) {
    // A check that cannot evaluate (e.g. a required param is missing) fails
    // CLOSED — it must never silently count as a pass.
    return {
      id: `deterministic:${checkName}`,
      description: `Deterministic check: ${checkName}`,
      severity: "error",
      message: `Check "${checkName}" errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    id: `deterministic:${checkName}`,
    description: `Deterministic check: ${checkName}`,
    severity: passed ? "pass" : "error",
    message: passed ? `Check "${checkName}" passed` : `Check "${checkName}" failed`,
  };
}

/**
 * List all registered check names.
 */
export function listChecks(): string[] {
  return [...registry.keys()];
}

// Built-in checks

/**
 * Resolve a REQUIRED check parameter. Throws when absent so runCheck reports
 * an error result instead of the check passing vacuously against a silent
 * default (e.g. contains '' matches everything).
 */
function requireParam(
  params: Record<string, unknown> | undefined,
  key: string,
  checkName: string,
): unknown {
  const value = params?.[key];
  if (value === undefined || value === null) {
    throw new Error(`check "${checkName}" requires params.${key}; refusing to evaluate without it`);
  }
  return value;
}

registerCheck("contains", (input, params) => {
  const needle = String(requireParam(params, "value", "contains"));
  return input.includes(needle);
});

registerCheck("not_contains", (input, params) => {
  const needle = String(requireParam(params, "value", "not_contains"));
  return !input.includes(needle);
});

registerCheck("regex_match", (input, params) => {
  const pattern = String(requireParam(params, "pattern", "regex_match"));
  const flags = String(params?.["flags"] ?? "");
  try {
    return new RegExp(pattern, flags).test(input);
  } catch {
    return false;
  }
});

registerCheck("min_length", (input, params) => {
  const min = Number(requireParam(params, "min", "min_length"));
  return input.length >= min;
});

registerCheck("max_length", (input, params) => {
  const max = Number(requireParam(params, "max", "max_length"));
  return input.length <= max;
});

registerCheck("not_empty", (input) => {
  return input.trim().length > 0;
});
