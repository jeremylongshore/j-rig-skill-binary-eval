/**
 * LiteLLM measurement adapter — candidate prototype implementing the
 * vendor-neutral `Provider` contract from `@j-rig/core`.
 *
 * Per PB-7 (`000-docs/018-AT-SPEC-pb7-adapter-measurement-protocol-2026-05-12.md`),
 * this is ONE of two candidate adapters (the other is `vercel-ai.ts`). Both
 * implement the same `Provider` interface and run the five eval cases
 * (EC-1..EC-5). The council later locks ONE as canonical; the loser is deleted
 * per § 11 step 7. THIS FILE IS A PROTOTYPE — not yet the locked production
 * adapter.
 *
 * LiteLLM's design: it exposes an OpenAI-compatible `/chat/completions`
 * surface and proxies to Anthropic, OpenAI, Google, etc. behind a single wire
 * shape. The adapter therefore normalizes ONCE (OpenAI-style request →
 * OpenAI-style response) and routes vendors via the `provider/model` model id.
 * That is the measurable property R5.3 scores: a low-divergence, single-shape
 * adapter.
 *
 * Network is isolated behind the `Transport` seam (see `transport.ts`) so this
 * prototype is deterministically testable without live keys and satisfies the
 * CISO gates (no key logging, no subprocess spawn).
 */
import { ProviderError } from "@j-rig/core";
import type {
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

const ADAPTER_NAME = "litellm";
const ADAPTER_VERSION = "0.1.0-prototype";
const DEFAULT_BASE_URL = "http://localhost:4000";

export interface LiteLlmAdapterOptions {
  /** Credential forwarded as the bearer token to the LiteLLM proxy. */
  apiKey: string;
  /** Base URL of the LiteLLM proxy. Defaults to the local dev proxy. */
  baseUrl?: string;
  /**
   * Injectable network seam. Defaults to a real `fetch` transport. Tests pass
   * a fake to exercise normalization deterministically.
   */
  transport?: Transport;
}

/**
 * Maps a LiteLLM/OpenAI-style `finish_reason` to the vendor-neutral
 * `FinishReason`. `content_filter` is mapped to `refusal` per PB-7's
 * "model refused (legitimate) vs provider errored (infra)" distinction —
 * a content filter is a legitimate model-side outcome, NOT a ProviderError.
 */
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
  return {
    inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
    outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
    ...(typeof (u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ===
    "number"
      ? {
          cachedInputTokens: (u.prompt_tokens_details as Record<string, number>).cached_tokens,
        }
      : {}),
  };
}

/** OpenAI-style message shape LiteLLM accepts on the wire. */
function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
        name: m.toolName,
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Translate a non-2xx LiteLLM/OpenAI proxy response into a ProviderError with
 * the unified category. The proxy preserves OpenAI's status-code semantics.
 */
function errorForStatus(status: number, body: unknown): ProviderError {
  const message =
    (((body as Record<string, unknown> | null)?.error as Record<string, unknown> | undefined)
      ?.message as string | undefined) ?? `LiteLLM proxy returned HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new ProviderError({ category: "authentication", providerName: ADAPTER_NAME, message });
  }
  if (status === 404) {
    return new ProviderError({ category: "model_not_found", providerName: ADAPTER_NAME, message });
  }
  if (status === 429) {
    return new ProviderError({ category: "rate_limit", providerName: ADAPTER_NAME, message });
  }
  if (status === 408 || status === 504) {
    return new ProviderError({ category: "network_timeout", providerName: ADAPTER_NAME, message });
  }
  return new ProviderError({ category: "unknown", providerName: ADAPTER_NAME, message });
}

/** Translate a thrown transport-layer error (abort, socket) into a ProviderError. */
function errorForThrow(err: unknown): ProviderError {
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

export class LiteLlmProvider implements Provider {
  readonly name = ADAPTER_NAME;
  readonly version = ADAPTER_VERSION;

  // Private — never exposed in error messages, returned values, or logs (G-1).
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #transport: Transport;

  constructor(opts: LiteLlmAdapterOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#transport = opts.transport ?? createFetchTransport();
  }

  #headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.#apiKey}`,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.#apiKey.length < 8) {
      throw new ProviderError({
        category: "authentication",
        providerName: this.name,
        message: "apiKey missing or too short",
      });
    }

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
      throw errorForStatus(res.status, res.json);
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
    // For the measurement prototype, streaming is normalized from a single
    // non-streaming proxy response into one text_delta + one finish chunk.
    // The locked production adapter would consume the proxy's SSE stream; the
    // measurable property here (R5.2 EC-2) is that streaming is a FIRST-CLASS
    // surface returning the normalized StreamChunk union, not a vendor leak.
    const completion = await this.complete(req);
    if (completion.text.length > 0) {
      yield { type: "text_delta", delta: completion.text };
    }
    yield { type: "finish", finishReason: completion.finishReason, usage: completion.usage };
  }

  async callTool(req: CompletionRequest & { tools: ToolDefinition[] }): Promise<ToolCallResult> {
    if (this.#apiKey.length < 8) {
      throw new ProviderError({
        category: "authentication",
        providerName: this.name,
        message: "apiKey missing or too short",
      });
    }

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
      throw errorForStatus(res.status, res.json);
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
    // Concurrent fan-out; per-request errors are returned in-band (EC-5
    // partial-success semantics) rather than rejecting the whole batch.
    return Promise.all(
      reqs.map((r) =>
        this.complete(r).catch((err: unknown) =>
          err instanceof ProviderError ? err : errorForThrow(err),
        ),
      ),
    );
  }

  // --- internals ---------------------------------------------------------

  async #send(body: unknown, signal?: AbortSignal): Promise<TransportResponse> {
    try {
      return await this.#transport({
        url: `${this.#baseUrl}/v1/chat/completions`,
        method: "POST",
        headers: this.#headers(),
        body,
        signal,
      });
    } catch (err) {
      throw errorForThrow(err);
    }
  }

  #firstChoice(json: unknown): Record<string, unknown> {
    const choices = (json as Record<string, unknown> | null)?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderError({
        category: "unknown",
        providerName: this.name,
        message: "LiteLLM response contained no choices",
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
