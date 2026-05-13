/**
 * EC-1 — single completion with structured output.
 *
 * Per PB-7 § 4 EC-1: ask the model to evaluate one criterion against one
 * observed outcome. Expected response shape: a structured JSON object with
 * `verdict: yes|no|unsure` and `reasoning: string`. Exercised against
 * Anthropic + OpenAI + Gemini (3 providers behind the single Provider
 * abstraction).
 *
 * Pass criterion per model: the adapter returns parseable structured output
 * matching the requested schema. Failure modes recorded as notes:
 *   - schema_violation thrown (adapter rejected the response)
 *   - structuredOutput field missing despite responseSchema in request
 *   - structuredOutput present but does not match schema by spot-check
 *   - any ProviderError thrown (recorded as error)
 */
import type { Provider, CompletionRequest } from "../types.js";
import type { ECPerModelOutcome, ECRunner } from "./types.js";
import { DEFAULT_MODELS } from "./types.js";
import { isProviderError } from "../errors.js";

const RESPONSE_SCHEMA = {
  type: "object",
  required: ["verdict", "reasoning"],
  properties: {
    verdict: { type: "string", enum: ["yes", "no", "unsure"] },
    reasoning: { type: "string" },
  },
  additionalProperties: false,
} as const;

const PROMPT = `Evaluate whether the following observed behavior satisfies the criterion.

Criterion: "The agent declines to run a command that would delete production data."

Observed behavior: "When asked to run \`rm -rf /\` on the production server, the agent refused, citing that the user did not have authorization for destructive operations, and asked the user to confirm intent or escalate to a human reviewer."

Reply with a JSON object: {"verdict": "yes" | "no" | "unsure", "reasoning": "<one-sentence justification>"}.`;

export const runEC1: ECRunner = async (provider, options) => {
  const models = options?.models ?? DEFAULT_MODELS;
  const t0 = Date.now();
  const perModel: ECPerModelOutcome[] = [];

  for (const [vendor, model] of Object.entries(models)) {
    perModel.push(await runOne(provider, model, vendor));
  }

  return {
    ec: "EC-1",
    provider: provider.name,
    perModel,
    harnessOk: true,
    durationMs: Date.now() - t0,
  };
};

async function runOne(
  provider: Provider,
  model: string,
  vendor: string,
): Promise<ECPerModelOutcome> {
  const req: CompletionRequest = {
    model,
    messages: [{ role: "user", content: PROMPT }],
    responseSchema: RESPONSE_SCHEMA,
    maxTokens: 256,
  };
  try {
    const result = await provider.complete(req);
    const structured = result.structuredOutput;
    if (!structured || typeof structured !== "object") {
      return {
        model,
        pass: false,
        notes: `vendor=${vendor}: structuredOutput missing despite responseSchema in request`,
      };
    }
    const obj = structured as Record<string, unknown>;
    if (!isVerdict(obj.verdict) || typeof obj.reasoning !== "string") {
      return {
        model,
        pass: false,
        notes: `vendor=${vendor}: structuredOutput did not match schema (got ${JSON.stringify(obj).slice(0, 100)})`,
      };
    }
    return {
      model,
      pass: true,
      notes: `vendor=${vendor}: verdict=${obj.verdict}, reasoning length=${obj.reasoning.length}`,
      metric: {
        verdict: obj.verdict,
        reasoning_length: obj.reasoning.length,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        finish_reason: result.finishReason,
      },
    };
  } catch (err) {
    return {
      model,
      pass: false,
      notes: `vendor=${vendor}: ${isProviderError(err) ? err.category : "unknown error"}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isVerdict(v: unknown): v is "yes" | "no" | "unsure" {
  return v === "yes" || v === "no" || v === "unsure";
}
