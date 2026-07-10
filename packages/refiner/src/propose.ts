/**
 * propose() adapter — PROVIDER-AGNOSTIC RefinerModel + tiered routing (plan 027
 * § 4 Phase A build-order step 6, "most complex; comes last").
 *
 * The PURE propose() mechanism lives in `@intentsolutions/refiner-core` behind the
 * `RefinerStrategy` interface (AC-13). A strategy needs a `RefinerModel` — a
 * single "prompt in, text out" completion seam — to do its work. This module is
 * the I/O adapter that supplies a REAL `RefinerModel` backed by a model client,
 * and the tiered-routing policy that picks which model id a pass runs on.
 *
 * PROVIDER-AGNOSTIC (this branch): propose() no longer hard-requires Anthropic.
 * It resolves a backend via {@link resolveProvider} (shared with score()) — an
 * explicit `--provider`, else the generic `LLM_*` triple, else auto-pick the first
 * present key preferring FREE/cheap OpenAI-compatible providers (nvidia →
 * deepseek → groq → anthropic). Two client formats are supported:
 *   - `anthropic` — the raw Messages API (unchanged; keeps the haiku|sonnet tier
 *     discipline + the no-opus guard, which are Anthropic-tier concepts).
 *   - `openai` — the OpenAI Chat Completions wire format (DeepSeek/Groq/NVIDIA/…),
 *     reusing the SAME single-turn shape the eval command's OpenAI-compat adapter
 *     uses. Raw vendor model ids; the no-opus guard does not apply.
 *
 * AC-5 (Huyen economics, P0-RATIFY): on the ANTHROPIC path, per-pass proposing
 * routes to `haiku` or `sonnet` ONLY. Opus is bound to final validation, reached
 * through a SEPARATE `validate()` path — never through propose(). The
 * {@link ProposeModelTier} type makes `opus` unrepresentable, and
 * {@link assertNotOpus} is a runtime belt-and-suspenders for an id that resolves
 * to an opus model. This tier discipline is Anthropic-specific; on the
 * OpenAI-compatible path any vendor model id is accepted.
 *
 * The model client is INJECTED via {@link CompletionClient} so unit tests mock it
 * (no live key needed to run the suite). The default clients speak the raw
 * Anthropic Messages API OR the OpenAI Chat Completions API through an injectable
 * transport — the same SDK-free convention the eval command's providers use, so
 * this adds no new dependency and stays CISO-gate-clean (key never logged).
 */

import type {
  RefinerModel,
  CompletionResult,
  ProposeContext,
  RefinerStrategy,
} from "@intentsolutions/refiner-core";
import type { EditProposal } from "@intentsolutions/refiner-core";
import type { ResolvedProvider } from "./providers.js";

/** Tiers a propose() pass may run on (Anthropic path). `opus` is intentionally absent (AC-5). */
export type ProposeModelTier = "haiku" | "sonnet";

/** Short tier alias → concrete Anthropic API model id (current GA; mirrors eval's map). */
const TIER_MODEL_ID: Record<ProposeModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
};

/** Concrete opus model ids that must NEVER back a propose() pass (AC-5 guard). */
const OPUS_MARKER = "opus";

/**
 * A minimal completion client: one request shape in, text out. The default impl
 * calls the Anthropic Messages API; tests inject a fake. Kept deliberately
 * smaller than the eval pipeline's `Provider` — propose() only needs single-turn
 * text completion.
 */
export interface CompletionClient {
  complete(req: {
    readonly model: string;
    readonly prompt: string;
    readonly maxTokens?: number;
  }): Promise<string>;
}

export class ProposeAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposeAdapterError";
  }
}

/**
 * Reject any model id that resolves to opus on the propose() path. AC-5 binds
 * Opus to final validation only; a per-pass proposer must never be opus, even if
 * a caller hand-passes a fully-qualified `claude-opus-*` id.
 *
 * @throws ProposeAdapterError if `modelId` looks like an opus model.
 */
export function assertNotOpus(modelId: string): void {
  if (modelId.toLowerCase().includes(OPUS_MARKER)) {
    throw new ProposeAdapterError(
      `propose() may not run on opus ('${modelId}') — Opus is final-validation-only (AC-5). ` +
        `Use haiku or sonnet for per-pass proposing.`,
    );
  }
}

/** Resolve a propose tier (or a fully-qualified id) to a concrete model id. */
export function resolveProposeModelId(tier: ProposeModelTier | string): string {
  const id = tier.startsWith("claude-") ? tier : (TIER_MODEL_ID[tier as ProposeModelTier] ?? tier);
  assertNotOpus(id);
  return id;
}

export interface ProposeModelOptions {
  /**
   * Model for the pass. On the Anthropic path a tier (`haiku`|`sonnet`, default
   * `sonnet`; opus unrepresentable). On the OpenAI-compatible path a raw vendor
   * model id (e.g. `meta/llama-3.3-70b-instruct`); when omitted the resolved
   * provider's default model is used.
   */
  readonly tier?: ProposeModelTier;
  /**
   * Wire format the client speaks — selects whether the no-opus tier discipline
   * applies. Defaults to `"anthropic"` for backward compatibility (existing
   * callers pass an Anthropic client + a tier).
   */
  readonly format?: "anthropic" | "openai";
  /**
   * On the OpenAI-compatible path, the raw model id to use. Ignored on the
   * Anthropic path (which resolves `tier` → concrete id). When omitted, the model
   * id is left to the caller/provider default (empty ⇒ the client must supply it).
   */
  readonly model?: string;
  /** Max tokens for the completion (default 1024). */
  readonly maxTokens?: number;
}

/**
 * Build a refiner-core {@link RefinerModel} backed by an injected completion
 * client. The returned model's `id` is the resolved model id (recorded on every
 * EditProposal as `refinerModel`, so a proposal is mechanism-AND-model traceable).
 *
 * On the ANTHROPIC path the tier is resolved to a concrete Anthropic id and the
 * no-opus guard fires (guaranteed non-opus). On the OPENAI-compatible path a raw
 * vendor model id is used verbatim — the tier discipline / no-opus guard are
 * Anthropic-tier concepts and do not apply.
 *
 * The `complete()` method returns a {@link CompletionResult} carrying both the
 * generated text and the token usage reported by the API. The {@link CompletionClient}
 * result (a plain string) is wrapped into a `CompletionResult` with a zero-usage
 * stub here; real usage will be surfaced when the client is upgraded to return
 * structured usage (wave 2+ / provider-adapter upgrade). The cost meter in
 * `@intentsolutions/refiner-core` will accumulate the usage field regardless — a zero stub
 * means "uncounted" tokens, not "no tokens used".
 *
 * @param client The completion client (real Anthropic / OpenAI-compat, or a test fake).
 * @param opts   tier|model + format + maxTokens.
 */
export function createRefinerModel(
  client: CompletionClient,
  opts: ProposeModelOptions = {},
): RefinerModel {
  const format = opts.format ?? "anthropic";
  const modelId =
    format === "anthropic"
      ? resolveProposeModelId(opts.tier ?? "sonnet") // throws if it resolves to opus
      : (opts.model ?? ""); // OpenAI-compat: raw vendor id, no tier discipline
  const maxTokens = opts.maxTokens ?? 1024;
  return {
    id: modelId,
    async complete(prompt: string): Promise<CompletionResult> {
      const text = await client.complete({ model: modelId, prompt, maxTokens });
      // Zero-usage stub until the CompletionClient interface is upgraded to
      // return structured usage (wave 2+ adapter upgrade).
      return { text, usage: { promptTokens: 0, completionTokens: 0 } };
    },
  };
}

/**
 * Run a {@link RefinerStrategy} against a doc + its scored rollouts, using a
 * tiered, non-opus model backed by the injected client. This is the adapter-side
 * `propose()` entry point: it assembles the {@link ProposeContext} the pure
 * strategy expects, then delegates the mechanism to the strategy.
 *
 * @returns The EditProposal the strategy produced (parent === doc.hash, carrying
 *          the strategy id + concrete model id).
 */
export async function propose(
  strategy: RefinerStrategy,
  ctx: Omit<ProposeContext, "model">,
  client: CompletionClient,
  opts: ProposeModelOptions = {},
): Promise<EditProposal> {
  const model = createRefinerModel(client, opts);
  return await strategy.propose({ ...ctx, model });
}

/**
 * Build the right {@link CompletionClient} for a resolved provider. This is the
 * client-selection seam the CLI uses AFTER {@link resolveProvider} decided which
 * backend to talk to: an `anthropic`-format provider gets the Messages-API client;
 * an `openai`-format provider gets the Chat-Completions client. Both route through
 * an injectable transport (default real `fetch`), so a test can hand a fake.
 */
export function createCompletionClient(
  resolved: ResolvedProvider,
  transport?: CompletionTransport,
): CompletionClient {
  if (resolved.format === "anthropic") {
    return new AnthropicCompletionClient({
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      ...(transport ? { transport } : {}),
    });
  }
  return new OpenAICompatCompletionClient({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    name: resolved.name,
    ...(transport ? { transport } : {}),
  });
}

/** Re-export the provider resolver so the CLI reaches it through this adapter. */
export { resolveProvider, NoProviderError, PROVIDER_REGISTRY } from "./providers.js";
export type { ResolvedProvider } from "./providers.js";

/**
 * Injectable transport for the default Anthropic client — POST a JSON body,
 * receive `{ status, json }`. Mirrors the eval command's `Transport` seam so the
 * same fake works across both.
 */
export interface CompletionTransport {
  (req: {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }): Promise<{ status: number; json: unknown }>;
}

const DEFAULT_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicCompletionClientOptions {
  /** Anthropic API key (held privately; never logged). */
  readonly apiKey: string;
  /** Override endpoint (testing / proxy). */
  readonly baseUrl?: string;
  /** Injectable network seam; defaults to a real `fetch`-backed transport. */
  readonly transport?: CompletionTransport;
}

/**
 * Default {@link CompletionClient} over the raw Anthropic Messages API. Adds no
 * SDK dependency (matches the repo convention); routes through an injectable
 * transport so the whole package — including this client — is testable without a
 * live key. The key is held privately and never echoed.
 */
export class AnthropicCompletionClient implements CompletionClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #transport: CompletionTransport;

  constructor(opts: AnthropicCompletionClientOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl ?? DEFAULT_MESSAGES_URL;
    this.#transport = opts.transport ?? createFetchTransport();
  }

  async complete(req: { model: string; prompt: string; maxTokens?: number }): Promise<string> {
    if (this.#apiKey.length < 8) {
      throw new ProposeAdapterError("Anthropic apiKey missing or too short");
    }
    // Defense in depth: never let an opus id reach the wire on this path.
    assertNotOpus(req.model);
    const res = await this.#transport({
      url: this.#baseUrl,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: {
        model: req.model,
        max_tokens: req.maxTokens ?? 1024,
        messages: [{ role: "user", content: req.prompt }],
      },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new ProposeAdapterError(`Anthropic API returned HTTP ${res.status}`);
    }
    return extractText(res.json);
  }
}

/** Concatenate text blocks from an Anthropic Messages API response. */
function extractText(json: unknown): string {
  const blocks = (json as Record<string, unknown> | null)?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

export interface OpenAICompatCompletionClientOptions {
  /** API key forwarded as the Bearer token (held privately; never logged). */
  readonly apiKey: string;
  /** Base URL of the OpenAI-compatible endpoint (no trailing `/chat/completions`). */
  readonly baseUrl: string;
  /** Short provider name for error attribution. */
  readonly name?: string;
  /** Injectable network seam; defaults to a real `fetch`-backed transport. */
  readonly transport?: CompletionTransport;
}

/**
 * {@link CompletionClient} over the OpenAI **Chat Completions** wire format
 * (`POST {base}/chat/completions`, `Authorization: Bearer <key>`,
 * `choices[0].message.content` response). This is the same single-turn shape the
 * eval command's `RealOpenAICompatProvider` uses, distilled to the "prompt in,
 * text out" surface propose() needs — so DeepSeek / Groq / NVIDIA / any
 * OpenAI-compatible endpoint backs a refiner pass with NO new SDK dependency and
 * NO tier discipline (raw vendor model ids; the no-opus guard is Anthropic-only).
 *
 * The key is held privately and never echoed (CISO G-1). Routes through the same
 * injectable `CompletionTransport` seam as the Anthropic client, so the whole
 * client — including this one — is testable without a live key or network.
 */
export class OpenAICompatCompletionClient implements CompletionClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #name: string;
  readonly #transport: CompletionTransport;

  constructor(opts: OpenAICompatCompletionClientOptions) {
    this.#apiKey = opts.apiKey;
    // Normalize: strip trailing slashes so `${base}/chat/completions` is clean.
    // A linear char-scan (not a `/\/+$/` regex) — the anchored one-or-more
    // quantifier is a polynomial-ReDoS shape on library-supplied input (CodeQL
    // js/polynomial-redos); a scan is O(n) with no backtracking.
    this.#baseUrl = stripTrailingSlashes(opts.baseUrl);
    this.#name = opts.name ?? "openai-compatible";
    this.#transport = opts.transport ?? createFetchTransport();
  }

  async complete(req: { model: string; prompt: string; maxTokens?: number }): Promise<string> {
    if (this.#apiKey.length < 8) {
      throw new ProposeAdapterError(`${this.#name} apiKey missing or too short`);
    }
    if (!req.model || req.model.length === 0) {
      throw new ProposeAdapterError(
        `${this.#name} requires a model id (pass --model, or ensure the provider has a default)`,
      );
    }
    const res = await this.#transport({
      url: `${this.#baseUrl}/chat/completions`,
      headers: {
        "content-type": "application/json",
        // Authorization: Bearer is the OpenAI-style auth every compatible vendor
        // accepts; placed here and never echoed (G-1).
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: {
        model: req.model,
        max_tokens: req.maxTokens ?? 1024,
        messages: [{ role: "user", content: req.prompt }],
      },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new ProposeAdapterError(`${this.#name} API returned HTTP ${res.status}`);
    }
    return extractChatCompletionText(res.json);
  }
}

/**
 * Strip trailing `/` characters in linear time. Deliberately NOT `s.replace(/\/+$/,
 * "")` — that anchored one-or-more quantifier is a polynomial-ReDoS shape when the
 * input is library-supplied (CodeQL js/polynomial-redos). A backward char-scan is
 * O(n) with no backtracking.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Pull `choices[0].message.content` from an OpenAI Chat Completions response. */
function extractChatCompletionText(json: unknown): string {
  const choices = (json as Record<string, unknown> | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as Record<string, unknown> | null)?.message as
    Record<string, unknown> | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

/** Real `fetch`-backed {@link CompletionTransport}. */
function createFetchTransport(): CompletionTransport {
  return async (req) => {
    const response = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };
}
