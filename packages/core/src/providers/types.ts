/**
 * Provider interface — vendor-neutral contract for model-provider adapters.
 *
 * Source: PB-7 measurement protocol
 * (`000-docs/018-AT-SPEC-pb7-adapter-measurement-protocol-2026-05-12.md`).
 *
 * This is the contract that BOTH the LiteLLM prototype AND the Vercel AI SDK
 * prototype implement when running the 5 eval cases (EC-1..EC-5). The
 * winning prototype's adapter becomes the canonical implementation.
 *
 * Design constraints:
 *   - Provider-neutral. No vendor-specific shapes leak through the interface.
 *   - Stream-first. EC-2 streaming is a primary surface, not a bolted-on
 *     wrapper around .complete().
 *   - Tool-call normalized. EC-3 expects identical caller-side code across
 *     Anthropic, OpenAI, Gemini.
 *   - Error-categorized. EC-4 expects throws to carry ProviderError with one
 *     of the closed ProviderErrorCategory values.
 *   - Batch-aware. EC-5 expects a first-class batching primitive.
 *
 * Authorship rule: this file defines TYPES ONLY. No runtime imports beyond
 * other types. Concrete adapters live in `packages/cli/src/providers/`.
 */

import type { ProviderError } from "./errors.js";

// --- Request shape --------------------------------------------------------

/** Single-turn message or multi-turn conversation. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * Content of the message. For tool-result messages, callers SHOULD include
   * the tool name and call id in the structured fields below.
   */
  content: string;
  /** For role="tool": the tool name being responded to. */
  toolName?: string;
  /** For role="tool" or role="assistant": correlation id from a prior tool call. */
  toolCallId?: string;
}

export interface CompletionRequest {
  /**
   * Provider-namespaced model identifier. The adapter MAY validate against a
   * known-model list. Recommended convention:
   *   - "anthropic/claude-sonnet-4"
   *   - "openai/gpt-4o"
   *   - "google/gemini-2.5-pro"
   * Allows the same Provider instance to route across vendors.
   */
  model: string;

  /** Either a single prompt OR a structured message sequence. */
  messages: ChatMessage[];

  /** Sampling controls. Adapters MAY clamp to provider-supported ranges. */
  maxTokens?: number;
  temperature?: number;

  /**
   * When provided, the model is asked to produce structured output matching
   * this JSON Schema (Draft 2020-12). The adapter MUST validate the response
   * against the schema before returning; non-conforming responses throw
   * ProviderError with category 'schema_violation'.
   */
  responseSchema?: object;

  /** Stop sequences. */
  stop?: string[];

  /**
   * Abort signal for graceful cancellation. Adapters MUST honor this in their
   * underlying SDK call when supported, and MUST otherwise short-circuit the
   * response stream on next chunk.
   */
  signal?: AbortSignal;
}

// --- Result shapes --------------------------------------------------------

/**
 * Reason the completion ended. The 'refusal' value distinguishes a LEGITIMATE
 * model output ("I won't do that") from a ProviderError (infrastructure
 * issue). The rollout-gate consumer treats these differently.
 */
export type FinishReason = "stop" | "length" | "tool_use" | "refusal" | "error";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Some providers expose cached-token accounting; advisory only. */
  cachedInputTokens?: number;
}

export interface CompletionResult {
  text: string;
  /** Present when CompletionRequest.responseSchema was provided. */
  structuredOutput?: unknown;
  /** Echo of the request's model identifier for downstream correlation. */
  model: string;
  usage: TokenUsage;
  finishReason: FinishReason;
}

// --- Streaming shapes -----------------------------------------------------

/** Discriminated union of streaming chunks. */
export type StreamChunk =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; toolCallId: string; toolName: string }
  | { type: "tool_call_delta"; toolCallId: string; argsDelta: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "finish"; finishReason: FinishReason; usage?: TokenUsage };

// --- Tool calling --------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 2020-12 for the tool's arguments. */
  inputSchema: object;
}

export interface ToolCallResult {
  /** Null when the model declined to call any tool. */
  toolName: string | null;
  /** Null when toolName is null OR when the call had no arguments. */
  toolArguments: Record<string, unknown> | null;
  /** Tool-call correlation id; null when no call was made. */
  toolCallId: string | null;
  /** Any accompanying text the model produced. May be empty. */
  text: string;
  finishReason: FinishReason;
  usage: TokenUsage;
}

// --- Provider contract ---------------------------------------------------

/**
 * The interface concrete adapters implement.
 *
 * Implementations MUST be safe to call concurrently from the same instance;
 * the contract assumes a Provider is shared state across requests, not a
 * one-shot factory.
 *
 * Implementations MUST satisfy the CISO PASS/FAIL gates G-1 (credential
 * redaction) and G-2 (env-var spillover) per PB-7 § 6.
 */
export interface Provider {
  /**
   * Short, lowercase identifier. Used in gate_id construction
   * (audit-harness:ci:..., j-rig:server:...). Examples: "litellm",
   * "vercel-ai-sdk".
   */
  readonly name: string;

  /** SemVer of the adapter (NOT the underlying SDK). */
  readonly version: string;

  /** Single non-streaming completion. EC-1. */
  complete(req: CompletionRequest): Promise<CompletionResult>;

  /**
   * Single streaming completion. EC-2. Returns an async iterable so callers
   * can use `for await (const chunk of stream)`.
   *
   * The iterable MUST end with exactly one chunk of type 'finish'.
   */
  completeStream(req: CompletionRequest): AsyncIterable<StreamChunk>;

  /** Tool-calling completion. EC-3. */
  callTool(req: CompletionRequest & { tools: ToolDefinition[] }): Promise<ToolCallResult>;

  /**
   * Concurrent batch of independent requests. EC-5. Implementations MUST
   * respect provider-specific concurrency limits (typically expressed via
   * the SDK's own batching primitive when available, or via p-limit-like
   * orchestration when not).
   *
   * Per-request errors are returned in-band as ProviderError elements rather
   * than throwing for the whole batch — partial success is the common case.
   */
  batch(reqs: CompletionRequest[]): Promise<Array<CompletionResult | ProviderError>>;
}
