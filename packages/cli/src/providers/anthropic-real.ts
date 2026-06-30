/**
 * Real Anthropic provider adapters (iaj-E10 dogfood).
 *
 * The shipped measurement adapters (`litellm.ts`, `vercel-ai.ts`) implement the
 * low-level vendor-neutral `Provider` contract (`complete` / `completeStream` /
 * `callTool` / `batch`) and speak a NORMALIZED GATEWAY shape — LiteLLM's
 * OpenAI-compatible proxy, or an AI-SDK gateway. The 7-layer `eval` command,
 * however, consumes the higher-level `TriggerProvider` / `ExecutionProvider` /
 * `JudgeProvider` interfaces.
 *
 * This file provides BOTH halves needed for a real behavioral dogfood against
 * the Anthropic API:
 *
 *   1. `RealAnthropicProvider` — a real `Provider` that speaks the actual
 *      Anthropic Messages API wire format (`POST /v1/messages`, `x-api-key` +
 *      `anthropic-version` headers, `content: [{type:"text",...}]` response).
 *      It routes the network call through the SAME injectable `Transport` seam
 *      the prototype adapters use, so it adds NO new SDK dependency and stays
 *      CISO-gate-clean (G-1 no key logging, G-2 no subprocess spawn). The key
 *      is held in a private field and never echoed.
 *
 *   2. `AnthropicTriggerProvider` / `AnthropicExecutionProvider` /
 *      `AnthropicJudgeProvider` — bridges that drive the real `Provider` to
 *      satisfy the three eval-pipeline contracts. These are the real
 *      counterparts the stub `anthropic.ts` header anticipates ("When the real
 *      Anthropic SDK adapter lands, real classes implement these same
 *      interfaces and eval.ts selects between real and stub on key presence").
 *
 * Model-id convention: the eval command passes short aliases (`sonnet`,
 * `haiku`, `opus`). `resolveAnthropicModel` maps those to concrete API model
 * ids; a fully-qualified `claude-*` id passes through unchanged.
 */

import { ProviderError } from "@j-rig/core";
import type {
  TriggerProvider,
  ExecutionProvider,
  ExecutionContext,
  ExecutionOutput,
  ExecutionMeta,
  JudgeProvider,
  JudgmentVerdict,
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  FinishReason,
  Provider,
  StreamChunk,
  TokenUsage,
  ToolCallResult,
  ToolDefinition,
} from "@j-rig/core";
import { createFetchTransport, type Transport, type TransportResponse } from "./transport.js";
import { extractVerdict } from "./verdict.js";

const ADAPTER_NAME = "anthropic";
const ADAPTER_VERSION = "1.0.0";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;

/** Short model aliases → concrete Anthropic API model ids. */
const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-5",
  opus: "claude-opus-4-1",
};

/**
 * Resolve a model alias or fully-qualified id to a concrete Anthropic API model
 * id. A value that already begins with `claude-` passes through unchanged so
 * callers can pin an exact dated snapshot.
 */
export function resolveAnthropicModel(model: string): string {
  if (model.startsWith("claude-")) return model;
  const stripped = model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
  return MODEL_ALIASES[stripped] ?? stripped;
}

/** Map an Anthropic `stop_reason` to the vendor-neutral `FinishReason`. */
function mapFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "refusal";
    default:
      return "stop";
  }
}

function mapUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const usage: TokenUsage = {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
  };
  if (typeof u.cache_read_input_tokens === "number") {
    usage.cachedInputTokens = u.cache_read_input_tokens;
  }
  return usage;
}

/**
 * Split the j-rig ChatMessage[] into the Anthropic `system` string + the
 * `messages` array. The Anthropic Messages API carries the system prompt as a
 * top-level field, not as a message with role `system`.
 */
function toAnthropicPayload(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Array<Record<string, unknown>>;
} {
  const systemParts: string[] = [];
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId ?? "",
            content: m.content,
          },
        ],
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

/** Translate a non-2xx Anthropic response into a categorized ProviderError. */
function errorForStatus(status: number, body: unknown): ProviderError {
  const message =
    (((body as Record<string, unknown> | null)?.error as Record<string, unknown> | undefined)
      ?.message as string | undefined) ?? `Anthropic API returned HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new ProviderError({ category: "authentication", providerName: ADAPTER_NAME, message });
  }
  if (status === 404) {
    return new ProviderError({ category: "model_not_found", providerName: ADAPTER_NAME, message });
  }
  if (status === 429) {
    return new ProviderError({ category: "rate_limit", providerName: ADAPTER_NAME, message });
  }
  if (status === 408 || status === 504 || status === 529) {
    return new ProviderError({ category: "network_timeout", providerName: ADAPTER_NAME, message });
  }
  return new ProviderError({ category: "unknown", providerName: ADAPTER_NAME, message });
}

function errorForThrow(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error && (err.name === "AbortError" || /abort|timeout/i.test(err.message))) {
    return new ProviderError({
      category: "network_timeout",
      providerName: ADAPTER_NAME,
      message: err.message,
      originalError: err,
    });
  }
  return new ProviderError({
    category: "unknown",
    providerName: ADAPTER_NAME,
    message: err instanceof Error ? err.message : String(err),
    originalError: err,
  });
}

/** Extract the concatenated text from an Anthropic `content` block array. */
function extractText(json: unknown): string {
  const blocks = (json as Record<string, unknown> | null)?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

export interface RealAnthropicProviderOptions {
  /** Anthropic API key (held privately; never logged — G-1). */
  apiKey: string;
  /** Override the Messages API endpoint (testing / proxy). */
  baseUrl?: string;
  /** Injectable network seam. Defaults to a real `fetch` transport. */
  transport?: Transport;
}

/**
 * Real Anthropic Messages-API `Provider`. Speaks the genuine wire format and
 * routes the HTTP call through the injectable `Transport` seam (so it is
 * deterministically testable with a fake transport AND makes real calls with
 * the default `createFetchTransport`).
 */
export class RealAnthropicProvider implements Provider {
  readonly name = ADAPTER_NAME;
  readonly version = ADAPTER_VERSION;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #transport: Transport;

  constructor(opts: RealAnthropicProviderOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.#transport = opts.transport ?? createFetchTransport();
  }

  #headers(): Record<string, string> {
    // x-api-key + anthropic-version are the real Messages API auth headers.
    // The key is placed here and never echoed in errors/returns/logs (G-1).
    return {
      "content-type": "application/json",
      "x-api-key": this.#apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.#assertKey();
    const { system, messages } = toAnthropicPayload(req.messages);
    const body: Record<string, unknown> = {
      model: resolveAnthropicModel(req.model),
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.stop !== undefined ? { stop_sequences: req.stop } : {}),
    };

    const res = await this.#send(body, req.signal);
    if (res.status < 200 || res.status >= 300) {
      throw errorForStatus(res.status, res.json);
    }

    const text = extractText(res.json);
    const result: CompletionResult = {
      text,
      model: req.model,
      usage: mapUsage((res.json as Record<string, unknown>).usage),
      finishReason: mapFinishReason((res.json as Record<string, unknown>).stop_reason),
    };
    if (req.responseSchema !== undefined) {
      result.structuredOutput = this.#parseStructured(text);
    }
    return result;
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    // Non-streaming dogfood: normalize a single completion into the StreamChunk
    // union. The eval pipeline does not depend on token-level streaming.
    const completion = await this.complete(req);
    if (completion.text.length > 0) {
      yield { type: "text_delta", delta: completion.text };
    }
    yield { type: "finish", finishReason: completion.finishReason, usage: completion.usage };
  }

  async callTool(req: CompletionRequest & { tools: ToolDefinition[] }): Promise<ToolCallResult> {
    this.#assertKey();
    const { system, messages } = toAnthropicPayload(req.messages);
    const body: Record<string, unknown> = {
      model: resolveAnthropicModel(req.model),
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      ...(system !== undefined ? { system } : {}),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    };

    const res = await this.#send(body, req.signal);
    if (res.status < 200 || res.status >= 300) {
      throw errorForStatus(res.status, res.json);
    }

    const json = (res.json ?? {}) as Record<string, unknown>;
    const text = extractText(json);
    const usage = mapUsage(json.usage);
    const blocks = Array.isArray(json.content) ? json.content : [];
    const toolUse = blocks.find(
      (b): b is Record<string, unknown> =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "tool_use",
    );
    if (!toolUse) {
      return {
        toolName: null,
        toolArguments: null,
        toolCallId: null,
        text,
        finishReason: mapFinishReason(json.stop_reason),
        usage,
      };
    }
    return {
      toolName: typeof toolUse.name === "string" ? toolUse.name : null,
      toolArguments:
        typeof toolUse.input === "object" && toolUse.input !== null
          ? (toolUse.input as Record<string, unknown>)
          : null,
      toolCallId: typeof toolUse.id === "string" ? toolUse.id : null,
      text,
      finishReason: "tool_use",
      usage,
    };
  }

  async batch(reqs: CompletionRequest[]): Promise<Array<CompletionResult | ProviderError>> {
    return Promise.all(
      reqs.map((r) =>
        this.complete(r).catch((err: unknown) =>
          err instanceof ProviderError ? err : errorForThrow(err),
        ),
      ),
    );
  }

  // --- internals ---------------------------------------------------------

  #assertKey(): void {
    if (this.#apiKey.length < 8) {
      throw new ProviderError({
        category: "authentication",
        providerName: this.name,
        message: "apiKey missing or too short",
      });
    }
  }

  async #send(body: unknown, signal?: AbortSignal): Promise<TransportResponse> {
    try {
      return await this.#transport({
        url: this.#baseUrl,
        method: "POST",
        headers: this.#headers(),
        body,
        signal,
      });
    } catch (err) {
      throw errorForThrow(err);
    }
  }

  #parseStructured(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError({
        category: "schema_violation",
        providerName: this.name,
        message: "responseSchema requested but model output was not valid JSON",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Eval-pipeline bridges: TriggerProvider / ExecutionProvider / JudgeProvider
// driven by a real `Provider`.
// ---------------------------------------------------------------------------

/**
 * Real trigger provider — asks the model which skill (if any) it would invoke
 * for a prompt, given the roster. Returns the selected skill name or null.
 */
export class AnthropicTriggerProvider implements TriggerProvider {
  readonly #provider: Provider;
  readonly #model: string;

  constructor(model: string, provider: Provider) {
    this.#model = model;
    this.#provider = provider;
  }

  async selectSkill(
    prompt: string,
    availableSkills: Array<{ name: string; description: string }>,
  ): Promise<{ selected: string | null; reasoning: string }> {
    const roster = availableSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    const system =
      "You are a skill router. Given a user prompt and a roster of available skills, " +
      "decide which single skill (if any) should handle the prompt. Respond ONLY with " +
      'a JSON object {"selected": "<skill-name-or-null>", "reasoning": "<one sentence>"}. ' +
      "Use null for selected when no skill fits.";
    const user = `Available skills:\n${roster}\n\nUser prompt: "${prompt}"`;

    const result = await this.#provider.complete({
      model: this.#model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: 256,
      temperature: 0,
    });

    const parsed = parseJsonObject(result.text);
    const rawSelected = parsed?.selected;
    const selected =
      typeof rawSelected === "string" && rawSelected !== "null" && rawSelected.length > 0
        ? rawSelected
        : null;
    const reasoning =
      typeof parsed?.reasoning === "string" ? parsed.reasoning : result.text.slice(0, 200);
    return { selected, reasoning };
  }
}

/**
 * Real execution provider — runs the skill body as a system prompt against the
 * test-case prompt and captures the model's actual output.
 */
export class AnthropicExecutionProvider implements ExecutionProvider {
  readonly #provider: Provider;
  readonly #model: string;

  constructor(model: string, provider: Provider) {
    this.#model = model;
    this.#provider = provider;
  }

  async execute(
    prompt: string,
    context: ExecutionContext,
    options?: { timeout_ms?: number; model?: string },
  ): Promise<ExecutionOutput & { meta: ExecutionMeta }> {
    const started = new Date();
    const model = options?.model ?? this.#model;
    const controller = options?.timeout_ms ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), options!.timeout_ms)
      : undefined;
    try {
      const result = await this.#provider.complete({
        model,
        messages: [
          { role: "system", content: context.skill_body },
          { role: "user", content: prompt },
        ],
        maxTokens: 1024,
        ...(controller ? { signal: controller.signal } : {}),
      });
      const completed = new Date();
      const meta: ExecutionMeta = {
        started_at: started.toISOString(),
        completed_at: completed.toISOString(),
        duration_ms: completed.getTime() - started.getTime(),
        timed_out: false,
      };
      return { text: result.text, artifacts: [], tool_calls: 0, meta };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Real judge provider — asks the model a yes/no question about whether the
 * observed output satisfies a criterion. The judge is a SEPARATE invocation
 * from the skill under test (non-negotiable design principle #2: the evaluator
 * is always separate).
 */
export class AnthropicJudgeProvider implements JudgeProvider {
  readonly #provider: Provider;
  readonly #model: string;

  constructor(model: string, provider: Provider) {
    this.#model = model;
    this.#provider = provider;
  }

  async judge(
    criterion_description: string,
    prompt: string,
    output: string,
    judge_prompt?: string,
  ): Promise<{ verdict: JudgmentVerdict; confidence: number; reasoning: string }> {
    const system =
      "You are a strict binary evaluator. Decide whether the OUTPUT satisfies the " +
      "CRITERION for the given PROMPT. Respond ONLY with a JSON object " +
      '{"verdict": "yes"|"no"|"unsure", "confidence": <0..1>, "reasoning": "<one sentence>"}.';
    const question = judge_prompt ?? `Does the output satisfy: ${criterion_description}?`;
    const user =
      `CRITERION: ${criterion_description}\n\n` +
      `QUESTION: ${question}\n\n` +
      `PROMPT: ${prompt}\n\n` +
      `OUTPUT:\n${output}`;

    const result = await this.#provider.complete({
      model: this.#model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // 2048 (was 256): a verdict + one-sentence reasoning can exceed 256
      // tokens and truncate the JSON object, losing the verdict. Matches the
      // openai-compatible judge budget (#173).
      maxTokens: 2048,
      temperature: 0,
    });

    const parsed = parseJsonObject(result.text);
    // Recover the verdict from the structured parse when available, else from a
    // regex over the raw text, so a truncated or fence-wrapped object no longer
    // silently drops a decisive "yes"/"no" to "unsure". See ./verdict.ts.
    const verdict: JudgmentVerdict = extractVerdict(result.text, parsed?.verdict);
    const confidence =
      typeof parsed?.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    const reasoning =
      typeof parsed?.reasoning === "string" ? parsed.reasoning : result.text.slice(0, 200);
    return { verdict, confidence, reasoning };
  }
}

/**
 * Parse a JSON object from model text, tolerating leading/trailing prose or
 * markdown code fences (models often wrap JSON in ```json ... ```). Returns
 * null if no JSON object can be extracted.
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
