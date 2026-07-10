/**
 * Refiner provider registry — the single place the Refiner learns "what LLM
 * backends exist, where they live, which env var carries their key, and how they
 * speak the wire". This is what makes the Refiner PROVIDER-AGNOSTIC: it no longer
 * hard-requires Anthropic. With only a DeepSeek / Groq / NVIDIA key set it "just
 * works" on a free/cheap OpenAI-compatible model; Anthropic is used only when it
 * is the credential that happens to be present (or explicitly chosen).
 *
 * WHY THIS SHAPE (and not a re-import of the eval command's registry): the eval
 * command's `PROVIDER_PRESETS` / `resolveOpenAICompatConfig` live in
 * `@intentsolutions/jrig-cli`, which DEPENDS ON this `@intentsolutions/refiner`
 * package. Importing the eval registry here would be a circular dependency. So the
 * registry is re-homed in the LOWER package (this one), where BOTH the refiner
 * adapters (propose/score) and — later, without a cycle — the CLI can consume it.
 * It is a byte-for-byte MIRROR of eval's names, base URLs, key env vars, model
 * defaults, and precedence order, so `refine` and `eval` agree on provider names
 * (a `refine score --provider deepseek` shells out to `j-rig eval --provider
 * deepseek` and they resolve the SAME backend).
 *
 * The one field this registry adds over eval's is the `format` discriminator
 * (`"anthropic" | "openai"`), because — unlike the eval command, which keeps
 * Anthropic on a wholly separate code path — the Refiner's propose() path selects
 * the client (Anthropic Messages vs OpenAI Chat Completions) from a single
 * resolved provider. So `anthropic` is a first-class registry entry here.
 */

/** Wire format a provider speaks. Selects which propose() client is built. */
export type ProviderFormat = "anthropic" | "openai";

/** A named backend: where it lives, which key it needs, its default model, its wire format. */
export interface ProviderEntry {
  /** Short, lowercase provider name (matches eval's `--provider` names). */
  readonly name: string;
  /**
   * Base URL. For `openai` format this is the Chat-Completions base (no trailing
   * `/chat/completions`); for `anthropic` format this is the Messages endpoint.
   */
  readonly baseUrl: string;
  /** Env var carrying this provider's API key (Bearer / x-api-key). */
  readonly keyEnv: string;
  /** Default model id when `--model` is omitted (overridable; vendor ids churn). */
  readonly defaultModel: string;
  /** Wire format — picks the propose() client. */
  readonly format: ProviderFormat;
}

/**
 * The registry. OpenAI-compatible presets MIRROR the eval command's
 * `PROVIDER_PRESETS` (same base URLs, key env vars, default models) so the two
 * commands resolve identical backends for the same `--provider` name. `anthropic`
 * is added as a first-class entry (eval keeps it on a separate path).
 *
 * Model ids are overridable via `--model` / `LLM_MODEL` so a newer snapshot can
 * be pinned without a code change (deliberate — vendor model ids churn).
 */
export const PROVIDER_REGISTRY: Record<string, ProviderEntry> = {
  // Paid fallback. Messages API, x-api-key auth. Default model mirrors the eval
  // command's sonnet tier (current GA).
  anthropic: {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com/v1/messages",
    keyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-6",
    format: "anthropic",
  },
  // FREE tier (build.nvidia.com NIM). Listed FIRST in the auto-pick order —
  // meta/llama-3.3-70b-instruct is $0. Base/key/model mirror eval's `nvidia`.
  nvidia: {
    name: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    defaultModel: "meta/llama-3.3-70b-instruct",
    format: "openai",
  },
  // Cheap. Base/key/model mirror eval's `deepseek` preset.
  deepseek: {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    keyEnv: "DEEPSEEK_API_KEY",
    format: "openai",
  },
  // Free tier (~30 rpm). Base/key/model mirror eval's `groq` preset.
  groq: {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyEnv: "GROQ_API_KEY",
    format: "openai",
  },
  // OpenAI proper (paid, but cheap + the most reliable JSON/instruction-following).
  openai: {
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    keyEnv: "OPENAI_API_KEY",
    format: "openai",
  },
  // Additional OpenAI-compatible presets carried for parity with eval (not in
  // the auto-pick order below, but selectable via an explicit `--provider`).
  kimi: {
    name: "kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.6",
    keyEnv: "MOONSHOT_API_KEY",
    format: "openai",
  },
  openrouter: {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "deepseek/deepseek-chat",
    keyEnv: "OPENROUTER_API_KEY",
    format: "openai",
  },
};

/** Alias `moonshot` → the `kimi` entry (same vendor). Mirrors eval. */
const PROVIDER_ALIASES: Record<string, string> = {
  moonshot: "kimi",
};

/**
 * Auto-pick preference order (used when NO `--provider` and NO generic `LLM_*`
 * triple is set): the first provider whose key env var is present wins. Ordered
 * by RELIABILITY-adjusted cost: `groq` (free tier, dependable) → `deepseek`
 * (cheap) → `openai` (paid, most reliable JSON) → `anthropic` (paid fallback) →
 * `nvidia` LAST. `nvidia` is $0 but its NIM free-tier endpoint is flaky
 * (503/non-JSON), so it is demoted to a last resort rather than removed — a user
 * whose ONLY key is `NVIDIA_API_KEY` still auto-resolves to it (and gets its
 * runtime behavior), but when a dependable key is also present that wins. This
 * is the "don't need Anthropic" core: with only a Groq/DeepSeek/OpenAI/NVIDIA
 * key, propose+score run without ever touching Anthropic.
 */
export const AUTO_PICK_ORDER: readonly string[] = [
  "groq",
  "deepseek",
  "openai",
  "anthropic",
  "nvidia",
];

/** A resolved, ready-to-use provider configuration for propose() / score(). */
export interface ResolvedProvider {
  /** Provider name (`anthropic` / `nvidia` / `deepseek` / … / `openai-compatible`). */
  readonly name: string;
  /** Wire format — the propose() client is selected from this. */
  readonly format: ProviderFormat;
  /** Base URL for the resolved backend. */
  readonly baseUrl: string;
  /** Resolved API key. */
  readonly apiKey: string;
  /** Default model id for this provider (a `--model` / explicit id still overrides). */
  readonly defaultModel: string;
}

export interface ResolveProviderOptions {
  /** Explicit `--provider <name>` — wins over everything else when its key is set. */
  readonly provider?: string;
  /** Environment to read keys / generic `LLM_*` from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Minimum plausible API-key length (mirrors eval's `>= 8` guard). */
const MIN_KEY_LEN = 8;

/** Resolve a registry entry by name or alias. */
function entryFor(name: string): ProviderEntry | undefined {
  const id = PROVIDER_ALIASES[name] ?? name;
  return PROVIDER_REGISTRY[id];
}

/** Read + trim an env var; return undefined when empty. */
function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * Error thrown when no usable provider credential is available. Lists the env
 * vars that were looked for so the operator knows exactly what to set.
 */
export class NoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderError";
  }
}

/**
 * Resolve which LLM backend the Refiner should use. THE PROVIDER-AGNOSTIC CORE —
 * shared by both propose() and score() so they always agree.
 *
 * Precedence:
 *   1. Explicit `--provider <name>` — wins IF its key env var is present. A named
 *      provider whose key is absent is a hard, loud miss (never a silent
 *      fall-through to a different vendor).
 *   2. The generic `LLM_BASE_URL` + `LLM_API_KEY` triple (OpenAI-compatible),
 *      `LLM_MODEL` optional, `LLM_PROVIDER` names it (default `openai-compatible`).
 *   3. Auto-pick: the first provider in {@link AUTO_PICK_ORDER} whose key env var
 *      is present — nvidia (free) → deepseek → groq → anthropic (paid fallback).
 *   4. None present → throw {@link NoProviderError} listing every env var checked.
 *
 * @throws NoProviderError when nothing resolves.
 */
export function resolveProvider(opts: ResolveProviderOptions = {}): ResolvedProvider {
  const env = opts.env ?? process.env;
  const explicit = opts.provider?.trim().toLowerCase();

  const llmBase = readEnv(env, "LLM_BASE_URL");
  const llmModel = readEnv(env, "LLM_MODEL");
  const llmKey = readEnv(env, "LLM_API_KEY");

  const fromEntry = (name: string): ResolvedProvider | null => {
    const entry = entryFor(name);
    if (!entry) return null;
    // A preset key OR the generic LLM_API_KEY may satisfy it (so an LLM_API_KEY
    // can back a named preset pointed at a custom gateway).
    const key = readEnv(env, entry.keyEnv) ?? llmKey;
    if (!key || key.length < MIN_KEY_LEN) return null;
    return {
      name: entry.name,
      format: entry.format,
      // Generic LLM_* vars, when set, MAY override a preset's base/model.
      baseUrl: entry.format === "openai" ? (llmBase ?? entry.baseUrl) : entry.baseUrl,
      apiKey: key,
      defaultModel: llmModel ?? entry.defaultModel,
    };
  };

  // 1. Explicit --provider.
  if (explicit) {
    const resolved = fromEntry(explicit);
    if (resolved) return resolved;
    const entry = entryFor(explicit);
    if (!entry) {
      throw new NoProviderError(
        `unknown provider '${explicit}' (known: ${Object.keys(PROVIDER_REGISTRY).join(", ")}, ` +
          `aliases: ${Object.keys(PROVIDER_ALIASES).join(", ")})`,
      );
    }
    throw new NoProviderError(
      `provider '${explicit}' was requested but its key env var ${entry.keyEnv} is not set ` +
        `(or is too short). Set ${entry.keyEnv}, or drop --provider to auto-pick.`,
    );
  }

  // 2. Generic LLM_* triple (OpenAI-compatible custom endpoint).
  if (llmKey && llmKey.length >= MIN_KEY_LEN && llmBase) {
    return {
      name: readEnv(env, "LLM_PROVIDER") ?? "openai-compatible",
      format: "openai",
      baseUrl: llmBase,
      apiKey: llmKey,
      defaultModel: llmModel ?? "",
    };
  }

  // 3. Auto-pick: first provider in preference order whose key is present.
  for (const name of AUTO_PICK_ORDER) {
    const resolved = fromEntry(name);
    if (resolved) return resolved;
  }

  // 4. Nothing. List every env var we looked for.
  const envVars = [
    ...AUTO_PICK_ORDER.map((n) => entryFor(n)!.keyEnv),
    "LLM_API_KEY (+ LLM_BASE_URL)",
  ];
  throw new NoProviderError(
    `no LLM provider credential found. The Refiner does NOT require Anthropic — set ANY of these ` +
      `and it will auto-pick (preferring free/cheap): ${envVars.join(", ")}. ` +
      `Or pass --provider <name> explicitly.`,
  );
}
