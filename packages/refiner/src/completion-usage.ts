import type { ModelUsage } from "@intentsolutions/refiner-core";

/** Selected numeric wire fields, retained for future explicit pricing policies. */
export interface CompletionMeasurement {
  readonly status: "reported" | "missing" | "invalid";
  readonly usage: ModelUsage | null;
  readonly reportedModel: string | null;
  readonly billingTokens: Readonly<Record<string, number>>;
}

export interface MeasuredCompletion {
  readonly text: string;
  readonly measurement: CompletionMeasurement;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Missing counts are not zero. Cache and reasoning subsets are not counted twice. */
export function readCompletionMeasurement(
  response: unknown,
  format: "anthropic" | "openai",
): CompletionMeasurement {
  const body = object(response);
  const model = body?.model;
  const reportedModel = typeof model === "string" && model.trim() ? model : null;
  const raw = body?.usage;
  const base = { reportedModel, usage: null, billingTokens: {} };
  if (raw === undefined || raw === null) return { ...base, status: "missing" };
  const usage = object(raw);
  if (!usage) return { ...base, status: "invalid" };
  const billingTokens: Record<string, number> = {};
  let valid = true;
  const read = (source: Record<string, unknown>, field: string, required = false, prefix = "") => {
    const value = source[field];
    if (value === undefined && !required) return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      valid = false;
      return 0;
    }
    billingTokens[prefix + field] = value;
    return value;
  };
  const detail = (field: string) => {
    if (usage[field] === undefined || usage[field] === null) return {};
    const result = object(usage[field]);
    if (!result) valid = false;
    return result ?? {};
  };
  let promptTokens: number;
  let completionTokens: number;
  if (format === "anthropic") {
    const input = read(usage, "input_tokens", true);
    completionTokens = read(usage, "output_tokens", true);
    const cached = read(usage, "cache_read_input_tokens");
    const written = read(usage, "cache_creation_input_tokens");
    promptTokens = input + cached + written;
    if (usage.cache_creation !== undefined && usage.cache_creation !== null) {
      const creation = detail("cache_creation");
      const short = read(creation, "ephemeral_5m_input_tokens", true, "cache_creation.");
      const long = read(creation, "ephemeral_1h_input_tokens", true, "cache_creation.");
      if (short + long !== written) valid = false;
    }
  } else {
    promptTokens = read(usage, "prompt_tokens", true);
    completionTokens = read(usage, "completion_tokens", true);
    if (
      usage.total_tokens !== undefined &&
      read(usage, "total_tokens") !== promptTokens + completionTokens
    )
      valid = false;
    const input = detail("prompt_tokens_details");
    const output = detail("completion_tokens_details");
    for (const field of ["cached_tokens", "cache_write_tokens", "audio_tokens"]) {
      if (read(input, field, false, "prompt_tokens_details.") > promptTokens) valid = false;
    }
    for (const field of [
      "reasoning_tokens",
      "audio_tokens",
      "accepted_prediction_tokens",
      "rejected_prediction_tokens",
    ]) {
      if (read(output, field, false, "completion_tokens_details.") > completionTokens)
        valid = false;
    }
  }
  if (!Number.isSafeInteger(promptTokens + completionTokens)) valid = false;
  if (!valid) return { ...base, status: "invalid" };
  return {
    status: "reported",
    reportedModel,
    usage: { promptTokens, completionTokens },
    billingTokens,
  };
}
