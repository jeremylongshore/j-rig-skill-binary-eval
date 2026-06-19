/**
 * Vercel AI SDK measurement adapter — candidate prototype implementing the
 * vendor-neutral `Provider` contract from `@j-rig/core`.
 *
 * Per PB-7 (`000-docs/018-AT-SPEC-pb7-adapter-measurement-protocol-2026-05-12.md`),
 * this is the second of two candidate adapters (the other is `litellm.ts`).
 * Both implement the same `Provider` interface and run the five eval cases
 * (EC-1..EC-5). The council later locks ONE as canonical; the loser is deleted
 * per § 11 step 7. THIS FILE IS A PROTOTYPE — not yet the locked production
 * adapter.
 *
 * The Vercel AI SDK's design differs from LiteLLM's single-proxy shape: it
 * routes each vendor through a per-provider model object (`anthropic(...)`,
 * `openai(...)`, `google(...)`) and the SDK normalizes the RESPONSE into a
 * unified `{ text, toolCalls, usage, finishReason }`. The measurable property
 * R5.3 scores: the adapter must select the right vendor route from the
 * `provider/model` id, but the SDK collapses the response shape for it. This
 * prototype reproduces that two-step shape — vendor route on the request side,
 * unified normalization on the response side.
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

const ADAPTER_NAME = "vercel-ai-sdk";
const ADAPTER_VERSION = "0.1.0-prototype";

/** The three vendors the launch leaderboard names (PB-7 § 7). */
type Vendor = "anthropic" | "openai" | "google";

interface VendorRoute {
  vendor: Vendor;
  /** Default gateway endpoint for the vendor (overridable per-vendor). */
  url: string;
  /** Bare model id (vendor prefix stripped). */
  modelId: string;
}

export interface VercelAiAdapterOptions {
  /** Credential forwarded to the gateway. */
  apiKey: string;
  /**
   * Per-vendor endpoint overrides. The AI SDK reads provider base URLs from
   * env / config; the prototype accepts them explicitly so tests are hermetic.
   */
  baseUrls?: Partial<Record<Vendor, string>>;
  /**
   * Injectable network seam. Defaults to a real `fetch` transport. Tests pass
   * a fake to exercise normalization deterministically.
   */
  transport?: Transport;
}

const DEFAULT_BASE_URLS: Record<Vendor, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
};

/**
 * Parse a `provider/model` id into a vendor route. Unknown vendors throw
 * `model_not_found` — the adapter cannot route a vendor it has no model object
 * for (this is the AI SDK's per-provider-object constraint surfaced).
 */
function routeFor(
  model: string,
  baseUrls: Partial<Record<Vendor, string>> | undefined,
): VendorRoute {
  const slash = model.indexOf("/");
  const prefix = slash === -1 ? "" : model.slice(0, slash);
  const modelId = slash === -1 ? model : model.slice(slash + 1);
  if (prefix !== "anthropic" && prefix !== "openai" && prefix !== "google") {
    throw new ProviderError({
      category: "model_not_found",
      providerName: ADAPTER_NAME,
      message: `no Vercel AI SDK provider object for vendor "${prefix || "<unprefixed>"}" (model "${model}")`,
    });
  }
  const vendor = prefix;
  return { vendor, url: baseUrls?.[vendor] ?? DEFAULT_BASE_URLS[vendor], modelId };
}

/**
 * The AI SDK collapses every vendor finish reason into its own enum
 * (`stop | length | tool-calls | content-filter | error | other`). This maps
 * that unified enum into our vendor-neutral `FinishReason`. `content-filter`
 * → `refusal` per PB-7's legitimate-refusal-vs-error distinction.
 */
function mapFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool-calls":
      return "tool_use";
    case "content-filter":
      return "refusal";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

function mapUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  // AI SDK normalizes usage to { inputTokens, outputTokens } (newer) or
  // { promptTokens, completionTokens } (older). Accept both.
  const input =
    typeof u.inputTokens === "number"
      ? u.inputTokens
      : typeof u.promptTokens === "number"
        ? u.promptTokens
        : 0;
  const output =
    typeof u.outputTokens === "number"
      ? u.outputTokens
      : typeof u.completionTokens === "number"
        ? u.completionTokens
        : 0;
  return { inputTokens: input, outputTokens: output };
}

function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  // AI SDK CoreMessage shape: { role, content } with tool messages carrying
  // toolCallId + toolName.
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        toolCallId: m.toolCallId ?? "",
        toolName: m.toolName,
      };
    }
    return { role: m.role, content: m.content };
  });
}

function errorForStatus(status: number, body: unknown): ProviderError {
  const message =
    (((body as Record<string, unknown> | null)?.error as Record<string, unknown> | undefined)
      ?.message as string | undefined) ?? `Vercel AI SDK gateway returned HTTP ${status}`;
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

export class VercelAiProvider implements Provider {
  readonly name = ADAPTER_NAME;
  readonly version = ADAPTER_VERSION;

  // Private — never exposed in error messages, returned values, or logs (G-1).
  readonly #apiKey: string;
  readonly #baseUrls: Partial<Record<Vendor, string>> | undefined;
  readonly #transport: Transport;

  constructor(opts: VercelAiAdapterOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrls = opts.baseUrls;
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
    const route = routeFor(req.model, this.#baseUrls);

    const body: Record<string, unknown> = {
      // AI SDK generateText() input shape (normalized, provider-agnostic).
      model: route.modelId,
      messages: toWireMessages(req.messages),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.stop !== undefined ? { stopSequences: req.stop } : {}),
      ...(req.responseSchema !== undefined
        ? { responseFormat: { type: "json", schema: req.responseSchema } }
        : {}),
    };

    const res = await this.#send(route.url, body, req.signal);
    if (res.status < 200 || res.status >= 300) {
      throw errorForStatus(res.status, res.json);
    }

    const obj = (res.json ?? {}) as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text : "";
    const result: CompletionResult = {
      text,
      model: req.model,
      usage: mapUsage(obj.usage),
      finishReason: mapFinishReason(obj.finishReason),
    };

    if (req.responseSchema !== undefined) {
      // AI SDK generateObject() returns a parsed `object`; if the gateway
      // returned text instead, parse it. Either path yields structuredOutput.
      if (obj.object !== undefined) {
        result.structuredOutput = obj.object;
      } else {
        result.structuredOutput = this.#parseStructured(text);
      }
    }
    return result;
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    // The AI SDK's streamText() is a first-class surface; the prototype
    // normalizes the single gateway response into the StreamChunk union so the
    // measured property (EC-2 first-class streaming, normalized shape) holds.
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
    const route = routeFor(req.model, this.#baseUrls);

    const body: Record<string, unknown> = {
      model: route.modelId,
      messages: toWireMessages(req.messages),
      // AI SDK tools shape: a record keyed by tool name with parameters schema.
      tools: Object.fromEntries(
        req.tools.map((t) => [t.name, { description: t.description, parameters: t.inputSchema }]),
      ),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    };

    const res = await this.#send(route.url, body, req.signal);
    if (res.status < 200 || res.status >= 300) {
      throw errorForStatus(res.status, res.json);
    }

    const obj = (res.json ?? {}) as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text : "";
    const usage = mapUsage(obj.usage);
    // AI SDK returns a normalized `toolCalls` array of
    // { toolCallId, toolName, args }.
    const toolCalls = Array.isArray(obj.toolCalls) ? obj.toolCalls : [];
    const first = toolCalls[0] as Record<string, unknown> | undefined;
    if (!first) {
      return {
        toolName: null,
        toolArguments: null,
        toolCallId: null,
        text,
        finishReason: mapFinishReason(obj.finishReason),
        usage,
      };
    }
    return {
      toolName: typeof first.toolName === "string" ? first.toolName : null,
      toolArguments: this.#normalizeArgs(first.args),
      toolCallId: typeof first.toolCallId === "string" ? first.toolCallId : null,
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

  async #send(url: string, body: unknown, signal?: AbortSignal): Promise<TransportResponse> {
    try {
      return await this.#transport({
        url,
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

  #normalizeArgs(raw: unknown): Record<string, unknown> | null {
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
