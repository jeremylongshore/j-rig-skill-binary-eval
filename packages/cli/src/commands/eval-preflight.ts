import type { ReasoningEffort } from "@j-rig/core";
import type { SkillEvalSpec } from "../lib/loaders.js";
import type { EvalOptions } from "./eval.js";
import { resolveOpenAICompatConfig } from "../providers/openai-compatible.js";
import { mergeBudgetLimits, type EvalBudgetLimits } from "../providers/budget.js";

export function positiveNumber(
  flag: string,
  raw: string | undefined,
  integer: boolean,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${flag} must be a positive ${integer ? "integer" : "number"}, got "${raw}"`);
  }
  return n;
}

/**
 * The operator's per-run budget flags. Each is optional; `mergeBudgetLimits`
 * combines them with the spec's `budget` (the stricter limit wins).
 */
export function resolveRunBudgetLimits(
  opts: Pick<EvalOptions, "maxUsd" | "maxTokens" | "maxWallMs" | "maxCalls">,
): EvalBudgetLimits {
  const maxUsd = positiveNumber("--max-usd", opts.maxUsd, false);
  const maxTokens = positiveNumber("--max-tokens", opts.maxTokens, true);
  const maxWallMs = positiveNumber("--max-wall-ms", opts.maxWallMs, true);
  const maxCalls = positiveNumber("--max-calls", opts.maxCalls, true);
  return {
    ...(maxUsd !== undefined ? { max_usd: maxUsd } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(maxWallMs !== undefined ? { max_wall_ms: maxWallMs } : {}),
    ...(maxCalls !== undefined ? { max_calls: maxCalls } : {}),
  };
}

/** Validate execution options without reading files, opening databases or calling providers. */
export function resolveExecutionParameters(
  opts: Pick<EvalOptions, "executionReasoningEffort" | "functional" | "provider">,
  env: NodeJS.ProcessEnv,
): { reasoning_effort: ReasoningEffort } | undefined {
  if (opts.executionReasoningEffort !== undefined) {
    if (!["none", "low", "medium", "high", "max"].includes(opts.executionReasoningEffort)) {
      throw new Error("--execution-reasoning-effort must be none, low, medium, high, or max");
    }
    const want = opts.provider?.trim().toLowerCase();
    if (
      opts.functional === false ||
      want === "stub" ||
      want === "anthropic" ||
      !resolveOpenAICompatConfig(env, want)
    ) {
      throw new Error(
        "--execution-reasoning-effort requires real OpenAI-compatible functional execution",
      );
    }
    return {
      reasoning_effort: opts.executionReasoningEffort as ReasoningEffort,
    };
  }
}

/** Resolve loaded-spec options in CLI refusal order, before opening the database.
 * The spec has already passed loadSkillEvalSpec and its schema sample bounds.
 * CLI override validation and its existing error messages remain unchanged.
 */
export function resolveSpecOptions(
  opts: Pick<
    EvalOptions,
    "requireReviewed" | "models" | "samples" | "maxUsd" | "maxTokens" | "maxWallMs" | "maxCalls"
  >,
  spec: Pick<SkillEvalSpec, "tags" | "models" | "samples" | "budget">,
  modelsExplicit: boolean,
) {
  if (opts.requireReviewed && spec.tags?.includes("needs-review")) {
    throw new Error(
      "eval spec is tagged needs-review: review the drafted fn-* items and remove the " +
        "'draft' and 'needs-review' tags before it can gate (--require-reviewed)",
    );
  }
  // Honor the spec's declared `models` unless the operator EXPLICITLY passed
  // `--models`. The spec author knows which model the skill targets (e.g.
  // `deepseek-v4-flash`); silently defaulting to the CLI's "sonnet" tested the
  // wrong model — and on the OpenAI-compatible path an unknown model id 400s
  // to empty output, so every judge criterion fails on an absent response and
  // the run blocks for a reason unrelated to skill quality. The `--models`
  // flag, when given, still overrides (source === "cli").
  const modelsCsv =
    modelsExplicit || spec.models.length === 0 ? opts.models : spec.models.join(",");
  const models = modelsCsv.split(",").map((m) => m.trim());

  // Judge sample count for N-sample majority voting: `--samples` (the
  // re-run/stability-protocol override) beats the spec's `samples`
  // default; a criterion's own `samples` beats both (resolved in the
  // judgment engine). Undefined = 1 = legacy single call.
  // Number(), not parseInt(): parseInt silently truncates "2.5" to 2;
  // Number keeps the fraction so the integer check below rejects it.
  const judgeSamples = opts.samples !== undefined ? Number(opts.samples) : spec.samples;
  if (judgeSamples !== undefined && (!Number.isInteger(judgeSamples) || judgeSamples < 1)) {
    throw new Error(`--samples must be a positive integer, got "${opts.samples}"`);
  }
  // Budget (spec `budget` + --max-* flags, stricter wins). Validated
  // before the DB opens so a bad flag costs nothing.
  const budgetLimits = mergeBudgetLimits(spec.budget, resolveRunBudgetLimits(opts));
  return { models, judgeSamples, budgetLimits };
}
