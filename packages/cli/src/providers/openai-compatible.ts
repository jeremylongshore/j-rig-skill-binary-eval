/**
 * Configurable OpenAI-compatible provider (iaj-E10 follow-on).
 *
 * The shipped real adapter (`anthropic-real.ts`) speaks the genuine Anthropic
 * Messages API. This file provides the SECOND real-provider family: a single
 * adapter that speaks the OpenAI **Chat Completions** wire format
 * (`POST {base}/chat/completions`, `Authorization: Bearer <key>`,
 * `choices[0].message.content` response) against ANY OpenAI-compatible endpoint.
 *
 * Why this matters: DeepSeek, Kimi/Moonshot, OpenRouter, and Together are all
 * Chat-Completions-compatible. The only things that differ between them are the
 * base URL, the model id, and which env var carries the key. So one adapter +
 * one config table covers all of them — no new SDK, no per-vendor adapter.
 *
 * It routes the HTTP call through the SAME injectable `Transport` seam the
 * prototype adapters (`litellm.ts`, `vercel-ai.ts`) and `anthropic-real.ts` use,
 * so it adds NO new dependency and stays CISO-gate-clean (G-1 no key logging,
 * G-2 no subprocess spawn). The key is held in a private field and never echoed.
 *
 * This file provides BOTH halves needed for a real behavioral dogfood:
 *
 *   1. `RealOpenAICompatProvider` — a real `Provider` (`complete` /
 *      `completeStream` / `callTool` / `batch`) speaking Chat Completions.
 *
 *   2. `OpenAICompatTriggerProvider` / `OpenAICompatExecutionProvider` /
 *      `OpenAICompatJudgeProvider` — bridges that drive the real `Provider` to
 *      satisfy the three eval-pipeline contracts the `eval` command consumes.
 *      These mirror the Anthropic bridges exactly (same prompts, same JSON
 *      parsing) so a DeepSeek/Kimi run and an Anthropic run differ ONLY in the
 *      backend, never in the eval logic.
 *
 * To switch providers, set three env vars (or pick a per-provider preset):
 *   - LLM_BASE_URL / LLM_MODEL / LLM_API_KEY  (generic), OR
 *   - DEEPSEEK_API_KEY / MOONSHOT_API_KEY / OPENROUTER_API_KEY (presets).
 * See `resolveOpenAICompatConfig` for the precedence + defaults table.
 */

import { ProviderError } from "@j-rig/core";
import type {
  TriggerProvider,
  ExecutionProvider,
  ExecutionContext,
  ExecutionOutput,
  ExecutionMeta,
  JudgeProvider,
  JudgeCallOptions,
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

const ADAPTER_VERSION = "1.0.0";

/**
 * max_tokens budget for the small structured-verdict calls (trigger routing,
 * judging). The OUTPUT is tiny (a one-line JSON verdict), but on a REASONING
 * model the hidden chain-of-thought is billed against max_tokens BEFORE the
 * verdict is emitted. At the old 256 ceiling the reasoning exhausted the budget
 * and returned empty text, which `parseJsonObject(null)` turned into a false
 * "unsure" verdict — the dominant cause of "criteria could not be judged".
 * 2048 leaves ample room for reasoning + the verdict on both reasoning and
 * non-reasoning models. (Verified against deepseek-v4-flash, 2026-06-29.)
 */
const REASONING_VERDICT_MAX_TOKENS = 2048;

/**
 * max_tokens for functional skill execution. Must leave room for a full skill
 * output AND (on reasoning models) the hidden reasoning tokens billed against
 * the budget. Default 8192; overridable via `JRIG_MAX_OUTPUT_TOKENS` so an
 * endpoint/model with a lower output ceiling (e.g. 4096) doesn't 400 — a
 * portability escape hatch flagged in review (#173).
 */
const EXECUTION_MAX_TOKENS: number = (() => {
  const n = Number(process.env.JRIG_MAX_OUTPUT_TOKENS);
  return Number.isInteger(n) && n > 0 ? n : 8192;
})();

// ---------------------------------------------------------------------------
// Provider presets + env-driven config resolution
// ---------------------------------------------------------------------------

/** A named OpenAI-compatible vendor preset. */
export interface ProviderPreset {
  /** Short, lowercase adapter/preset name (used in the `Provider.name` field). */
  readonly id: string;
  /** Default base URL (no trailing `/chat/completions`). */
  readonly baseUrl: string;
  /** Default model id when none is supplied. */
  readonly defaultModel: string;
  /** Env var name that carries this preset's API key. */
  readonly keyEnv: string;
}

/**
 * The defaults table. Every preset is OpenAI-Chat-Completions-compatible and
 * authenticates with a Bearer token. Model ids are overridable via
 * `LLM_MODEL` / `--model` so a newer snapshot can be pinned without a code
 * change (deliberate, since vendor model ids churn).
 */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    // deepseek-v4-flash (V4 Lite) is the current fast coding/general model
    // (1M context, 13B-active MoE); deepseek-reasoner is the reasoning model.
    // The legacy "deepseek-chat" alias deprecates 2026-07-24 — it just maps to
    // v4-flash non-thinking mode. Override via LLM_MODEL/--model to switch.
    defaultModel: "deepseek-v4-flash",
    keyEnv: "DEEPSEEK_API_KEY",
  },
  kimi: {
    id: "kimi",
    // Moonshot's international endpoint. platform.kimi.ai is the console;
    // api.moonshot.ai/v1 is the OpenAI-compatible API surface.
    baseUrl: "https://api.moonshot.ai/v1",
    // Kimi K2.6 (latest, April 2026 — 1M ctx, coding/agentic). Model ids churn
    // on the vendor side — override via LLM_MODEL/--model when needed.
    defaultModel: "kimi-k2.6",
    keyEnv: "MOONSHOT_API_KEY",
  },
  openrouter: {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    // OpenRouter namespaces models as <org>/<model>. Pick Kimi or DeepSeek by
    // overriding LLM_MODEL/--model.
    defaultModel: "deepseek/deepseek-chat",
    keyEnv: "OPENROUTER_API_KEY",
  },
};

/** Alias `moonshot` → the `kimi` preset (same vendor). */
const PRESET_ALIASES: Record<string, string> = {
  moonshot: "kimi",
};

/** Resolved, ready-to-use OpenAI-compatible provider configuration. */
export interface OpenAICompatConfig {
  /** Short provider name (`deepseek` / `kimi` / `openrouter` / `openai-compatible`). */
  name: string;
  /** Base URL (no trailing `/chat/completions`). */
  baseUrl: string;
  /** Resolved API key (Bearer token). */
  apiKey: string;
  /** Default model id for this config (per-request `model` still overrides). */
  defaultModel: string;
}

/**
 * Resolve an OpenAI-compatible provider config from the environment.
 *
 * Precedence (first non-empty wins):
 *   1. An explicit `preferred` preset (from a `--provider` flag), if its key is set.
 *   2. The generic `LLM_BASE_URL` + `LLM_MODEL` + `LLM_API_KEY` triple (when the
 *      key is present). `LLM_PROVIDER` names it; defaults to `openai-compatible`.
 *   3. Each built-in preset in order — deepseek, then kimi, then openrouter —
 *      selecting the first whose key env var is set.
 *
 * Returns `null` when no OpenAI-compatible credential is available (the caller
 * then falls through to Anthropic / stub selection).
 *
 * Generic `LLM_*` vars, when set, MAY override a preset's base/model so a preset
 * key can still point at a custom gateway. `LLM_MODEL` always wins for the model.
 */
export function resolveOpenAICompatConfig(
  env: NodeJS.ProcessEnv = process.env,
  preferred?: string,
): OpenAICompatConfig | null {
  const llmBase = env.LLM_BASE_URL?.trim();
  const llmModel = env.LLM_MODEL?.trim();
  const llmKey = env.LLM_API_KEY?.trim();

  const fromPreset = (presetId: string): OpenAICompatConfig | null => {
    const id = PRESET_ALIASES[presetId] ?? presetId;
    const preset = PROVIDER_PRESETS[id];
    if (!preset) return null;
    const key = (env[preset.keyEnv] ?? llmKey)?.trim();
    if (!key || key.length < 8) return null;
    return {
      name: preset.id,
      baseUrl: llmBase || preset.baseUrl,
      apiKey: key,
      defaultModel: llmModel || preset.defaultModel,
    };
  };

  // 1. Explicit --provider preset (only if its key resolves).
  if (preferred) {
    const explicit = fromPreset(preferred);
    if (explicit) return explicit;
    // A named preset whose key is absent is a hard miss for the explicit path —
    // do NOT silently fall through to a different vendor.
    return null;
  }

  // 2. Generic LLM_* triple (key present).
  if (llmKey && llmKey.length >= 8 && llmBase) {
    return {
      name: env.LLM_PROVIDER?.trim() || "openai-compatible",
      baseUrl: llmBase,
      apiKey: llmKey,
      defaultModel: llmModel || "",
    };
  }

  // 3. Built-in presets in priority order.
  for (const presetId of ["deepseek", "kimi", "openrouter"]) {
    const cfg = fromPreset(presetId);
    if (cfg) return cfg;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wire normalization helpers (OpenAI Chat Completions shape)
// ---------------------------------------------------------------------------

/** Map an OpenAI-style `finish_reason` to the vendor-neutral `FinishReason`. */
function mapFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "stop";
  }
}

function mapUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const usage: TokenUsage = {
    inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
    outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
  };
  const cached = (u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens;
  if (typeof cached === "number") {
    usage.cachedInputTokens = cached;
  }
  return usage;
}

/** OpenAI-style message shape the Chat Completions endpoint accepts. */
function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
        ...(m.toolName ? { name: m.toolName } : {}),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Translate a non-2xx response into a categorized ProviderError. */
function errorForStatus(name: string, status: number, body: unknown): ProviderError {
  const message =
    (((body as Record<string, unknown> | null)?.error as Record<string, unknown> | undefined)
      ?.message as string | undefined) ?? `${name} API returned HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new ProviderError({ category: "authentication", providerName: name, message });
  }
  if (status === 404) {
    return new ProviderError({ category: "model_not_found", providerName: name, message });
  }
  if (status === 429) {
    return new ProviderError({ category: "rate_limit", providerName: name, message });
  }
  if (status === 408 || status === 504 || status === 529 || status === 503) {
    return new ProviderError({ category: "network_timeout", providerName: name, message });
  }
  return new ProviderError({ category: "unknown", providerName: name, message });
}

function errorForThrow(name: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error && (err.name === "AbortError" || /abort|timeout/i.test(err.message))) {
    return new ProviderError({
      category: "network_timeout",
      providerName: name,
      message: err.message,
      originalError: err,
    });
  }
  return new ProviderError({
    category: "unknown",
    providerName: name,
    message: err instanceof Error ? err.message : String(err),
    originalError: err,
  });
}

export interface RealOpenAICompatProviderOptions {
  /** API key forwarded as the Bearer token (held privately; never logged — G-1). */
  apiKey: string;
  /** Base URL of the OpenAI-compatible endpoint (no trailing `/chat/completions`). */
  baseUrl: string;
  /** Short provider name for error attribution + gate_id construction. */
  name?: string;
  /** Injectable network seam. Defaults to a real `fetch` transport. */
  transport?: Transport;
}

/**
 * Real OpenAI-compatible Chat-Completions `Provider`. Works against DeepSeek,
 * Kimi/Moonshot, OpenRouter, Together, or any compatible endpoint — the
 * difference is entirely in `baseUrl` + `apiKey` + the per-request `model`.
 */
export class RealOpenAICompatProvider implements Provider {
  readonly name: string;
  readonly version = ADAPTER_VERSION;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #transport: Transport;

  constructor(opts: RealOpenAICompatProviderOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.name = opts.name ?? "openai-compatible";
    this.#transport = opts.transport ?? createFetchTransport();
  }

  #headers(): Record<string, string> {
    // Authorization: Bearer is the OpenAI-style auth header every compatible
    // vendor accepts. The key is placed here and never echoed (G-1).
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.#apiKey}`,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.#assertKey();
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toWireMessages(req.messages),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.stop !== undefined ? { stop: req.stop } : {}),
      ...(req.responseSchema !== undefined
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "response", schema: req.responseSchema, strict: true },
            },
          }
        : {}),
    };

    const res = await this.#send(body, req.signal);
    if (res.status < 200 || res.status >= 300) {
      throw errorForStatus(this.name, res.status, res.json);
    }

    const choice = this.#firstChoice(res.json);
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const text = typeof message.content === "string" ? message.content : "";

    const result: CompletionResult = {
      text,
      model: req.model,
      usage: mapUsage((res.json as Record<string, unknown>).usage),
      finishReason: mapFinishReason(choice.finish_reason),
    };
    if (req.responseSchema !== undefined) {
      result.structuredOutput = this.#parseStructured(text);
    }
    return result;
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    // Non-streaming normalization: a single completion mapped into the
    // StreamChunk union. The eval pipeline does not depend on token-level
    // streaming (same approach as the other real/prototype adapters).
    const completion = await this.complete(req);
    if (completion.text.length > 0) {
      yield { type: "text_delta", delta: completion.text };
    }
    yield { type: "finish", finishReason: completion.finishReason, usage: completion.usage };
  }

  async callTool(req: CompletionRequest & { tools: ToolDefinition[] }): Promise<ToolCallResult> {
    this.#assertKey();
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toWireMessages(req.messages),
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    };

    const res = await this.#send(body, req.signal);
    if (res.status < 200 || res.status >= 300) {
      throw errorForStatus(this.name, res.status, res.json);
    }

    const choice = this.#firstChoice(res.json);
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const text = typeof message.content === "string" ? message.content : "";
    const usage = mapUsage((res.json as Record<string, unknown>).usage);

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const first = toolCalls[0] as Record<string, unknown> | undefined;
    if (!first) {
      return {
        toolName: null,
        toolArguments: null,
        toolCallId: null,
        text,
        finishReason: mapFinishReason(choice.finish_reason),
        usage,
      };
    }

    const fn = (first.function ?? {}) as Record<string, unknown>;
    return {
      toolName: typeof fn.name === "string" ? fn.name : null,
      toolArguments: this.#parseToolArgs(fn.arguments),
      toolCallId: typeof first.id === "string" ? first.id : null,
      text,
      finishReason: "tool_use",
      usage,
    };
  }

  async batch(reqs: CompletionRequest[]): Promise<Array<CompletionResult | ProviderError>> {
    return Promise.all(
      reqs.map((r) =>
        this.complete(r).catch((err: unknown) =>
          err instanceof ProviderError ? err : errorForThrow(this.name, err),
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
        url: `${this.#baseUrl}/chat/completions`,
        method: "POST",
        headers: this.#headers(),
        body,
        signal,
      });
    } catch (err) {
      throw errorForThrow(this.name, err);
    }
  }

  #firstChoice(json: unknown): Record<string, unknown> {
    const choices = (json as Record<string, unknown> | null)?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderError({
        category: "unknown",
        providerName: this.name,
        message: `${this.name} response contained no choices`,
      });
    }
    return choices[0] as Record<string, unknown>;
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

  #parseToolArgs(raw: unknown): Record<string, unknown> | null {
    if (raw == null) return null;
    if (typeof raw === "object") return raw as Record<string, unknown>;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Eval-pipeline bridges: TriggerProvider / ExecutionProvider / JudgeProvider
// ---------------------------------------------------------------------------
//
// These mirror the Anthropic bridges 1:1 (same system prompts, same JSON
// parsing). A DeepSeek/Kimi run and an Anthropic run therefore differ ONLY in
// which backend `Provider` they drive — the eval semantics are identical.

/**
 * Parse a JSON object from model text, tolerating leading/trailing prose or
 * markdown code fences. Returns null if no JSON object can be extracted.
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

/** Real trigger provider — asks the model which skill (if any) it would invoke. */
export class OpenAICompatTriggerProvider implements TriggerProvider {
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
      maxTokens: REASONING_VERDICT_MAX_TOKENS,
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

/** Real execution provider — runs the skill body as a system prompt. */
export class OpenAICompatExecutionProvider implements ExecutionProvider {
  readonly #provider: Provider;
  readonly #model: string;

  constructor(model: string, provider: Provider) {
    this.#model = model;
    this.#provider = provider;
  }

  async execute(
    prompt: string,
    context: ExecutionContext,
    options?: { timeout_ms?: number; model?: string; temperature?: number },
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
        // Honor the eval's execution-temperature pin (reproducible outputs);
        // absent, the API default (~1.0) applies.
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        // Functional execution must leave room for a full skill output AND, on
        // reasoning models (e.g. deepseek-v4-flash), the hidden reasoning tokens
        // that count against max_tokens but never appear in `content`. At the old
        // 1024 ceiling a complex skill task exhausted the budget on reasoning and
        // returned EMPTY `content` with finish_reason=length — silently feeding
        // the judges nothing to grade (a false BLOCK). Empirically, a complex
        // databricks-cost-leak-hunter task used ~667 reasoning + ~5.8k content
        // tokens; 8192 clears both with margin. (Verified 2026-06-29.) Override
        // via JRIG_MAX_OUTPUT_TOKENS for endpoints with a lower output ceiling.
        maxTokens: EXECUTION_MAX_TOKENS,
        ...(controller ? { signal: controller.signal } : {}),
      });
      const completed = new Date();
      const meta: ExecutionMeta = {
        started_at: started.toISOString(),
        completed_at: completed.toISOString(),
        duration_ms: completed.getTime() - started.getTime(),
        timed_out: false,
      };
      // Surface a reasoning-model budget exhaustion rather than passing empty
      // output downstream as if the skill produced nothing: an empty completion
      // that stopped on `length` means the token budget was consumed (by hidden
      // reasoning and/or a long answer) before any content was emitted — a
      // truncation, not a real empty skill output.
      if (result.text.trim() === "" && result.finishReason === "length") {
        throw new Error(
          `functional execution returned empty output truncated at max_tokens ` +
            `(finish_reason=length) for model '${model}': the token budget was exhausted ` +
            `before any content was emitted (common on reasoning models). Raise maxTokens.`,
        );
      }
      return { text: result.text, artifacts: [], tool_calls: 0, meta };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Real judge provider — a SEPARATE invocation from the skill under test
 * (design principle #2: the evaluator never judges itself).
 */
export class OpenAICompatJudgeProvider implements JudgeProvider {
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
    options?: JudgeCallOptions,
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
      maxTokens: REASONING_VERDICT_MAX_TOKENS,
      // Greedy by default; multi-sample majority voting passes a temperature
      // so the N samples draw independent verdicts.
      temperature: options?.temperature ?? 0,
    });

    const parsed = parseJsonObject(result.text);
    // Recover the verdict from the structured parse when available, else from a
    // regex over the raw text, so a truncated (verbose reasoning past the token
    // ceiling) or fence-wrapped object no longer silently drops a decisive
    // "yes"/"no" to "unsure". See ./verdict.ts.
    const verdict: JudgmentVerdict = extractVerdict(result.text, parsed?.verdict);
    const confidence =
      typeof parsed?.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    const reasoning =
      typeof parsed?.reasoning === "string" ? parsed.reasoning : result.text.slice(0, 200);
    return { verdict, confidence, reasoning };
  }
}
