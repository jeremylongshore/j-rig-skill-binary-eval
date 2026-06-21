/**
 * propose() adapter — Anthropic-backed RefinerModel + tiered routing (plan 027
 * § 4 Phase A build-order step 6, "most complex; comes last").
 *
 * The PURE propose() mechanism lives in `@intentsolutions/refiner-core` behind the
 * `RefinerStrategy` interface (AC-13). A strategy needs a `RefinerModel` — a
 * single "prompt in, text out" completion seam — to do its work. This module is
 * the I/O adapter that supplies a REAL `RefinerModel` backed by a model client,
 * and the tiered-routing policy that picks which model id a pass runs on.
 *
 * AC-5 (Huyen economics, P0-RATIFY): per-pass proposing routes to `haiku` or
 * `sonnet` ONLY. Opus is bound to final validation, reached through a SEPARATE
 * `validate()` path — never through propose(). The {@link ProposeModelTier} type
 * makes `opus` unrepresentable here, and {@link assertNotOpus} is a runtime
 * belt-and-suspenders for an id that resolves to an opus model.
 *
 * The model client is INJECTED via {@link CompletionClient} so unit tests mock it
 * (no live ANTHROPIC_API_KEY needed to run the suite). The default client speaks
 * the raw Anthropic Messages API through an injectable transport — the same
 * SDK-free convention the eval command's RealAnthropicProvider uses, so this adds
 * no new dependency and stays CISO-gate-clean (key never logged).
 */

import type {
  RefinerModel,
  CompletionResult,
  ProposeContext,
  RefinerStrategy,
} from "@intentsolutions/refiner-core";
import type { EditProposal } from "@intentsolutions/refiner-core";

/** Tiers a propose() pass may run on. `opus` is intentionally absent (AC-5). */
export type ProposeModelTier = "haiku" | "sonnet";

/** Short tier alias → concrete Anthropic API model id (mirrors eval's map). */
const TIER_MODEL_ID: Record<ProposeModelTier, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-5",
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
  /** Tier for the pass (default sonnet). Opus is unrepresentable here. */
  readonly tier?: ProposeModelTier;
  /** Max tokens for the completion (default 1024). */
  readonly maxTokens?: number;
}

/**
 * Build a refiner-core {@link RefinerModel} backed by an injected completion
 * client + a tier. The returned model's `id` is the resolved concrete model id
 * (recorded on every EditProposal as `refinerModel`, so a proposal is
 * mechanism-AND-model traceable). Guaranteed non-opus.
 *
 * The `complete()` method returns a {@link CompletionResult} carrying both the
 * generated text and the token usage reported by the API. The {@link CompletionClient}
 * result (a plain string) is wrapped into a `CompletionResult` with a zero-usage
 * stub here; real usage will be surfaced when the client is upgraded to return
 * structured usage (wave 2+ / provider-adapter upgrade). The cost meter in
 * `@intentsolutions/refiner-core` will accumulate the usage field regardless — a zero stub
 * means "uncounted" tokens, not "no tokens used".
 *
 * @param client The completion client (real Anthropic, or a test fake).
 * @param opts   tier (default sonnet) + maxTokens.
 */
export function createRefinerModel(
  client: CompletionClient,
  opts: ProposeModelOptions = {},
): RefinerModel {
  const tier: ProposeModelTier = opts.tier ?? "sonnet";
  const modelId = resolveProposeModelId(tier); // throws if it resolves to opus
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
