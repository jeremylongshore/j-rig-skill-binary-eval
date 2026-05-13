/**
 * EC-4 — error category enumeration.
 *
 * Per PB-7 § 4 EC-4: deliberately trigger each of the 5 declared error
 * categories per provider and observe the adapter's emitted error
 * type/shape.
 *
 * Pass criterion per model: the adapter throws ProviderError with the
 * expected `category` for EACH of the 5 trigger scenarios. Authentication
 * is tested with a sentinel-bad key; the others use small operational
 * triggers (typo model name for model_not_found, exhausted-quota workspace
 * for rate_limit, etc.).
 *
 * Note: some triggers depend on operator setup (e.g. having a known
 * exhausted-quota workspace). The runner returns NOT_APPLICABLE for any
 * trigger the operator hasn't configured, rather than failing.
 *
 * Per the PB-7 anti-pattern rules: this EC is operator-configurable. The
 * Decision Record records WHICH triggers ran for each prototype; missing
 * triggers don't penalize one prototype over the other as long as the
 * same triggers ran on both.
 */
import type { Provider } from "../types.js";
import type {
  ECResult,
  ECPerModelOutcome,
  ECRunner,
  ECRunnerOptions,
} from "./types.js";
import { DEFAULT_MODELS } from "./types.js";
import { isProviderError, type ProviderErrorCategory } from "../errors.js";

export interface EC4Triggers {
  /** When false, skip the bad-key test for this model. */
  testAuthentication?: boolean;
  /** When provided, name of an exhausted-quota workspace/model to trigger 429. */
  testRateLimit?: { model: string };
  /** When provided, a known-wrong model name to trigger model_not_found. */
  testModelNotFound?: { model: string };
  /** When provided, a prompt that the provider WILL refuse (content policy). */
  testContentPolicyRefusal?: { prompt: string };
  /** When provided, ms timeout that will be tighter than provider latency. */
  testNetworkTimeout?: { timeoutMs: number };
}

export interface EC4Options extends ECRunnerOptions {
  triggers?: EC4Triggers;
  /**
   * Factory that returns a Provider instance configured with the given key.
   * The runner uses this to create a bad-key Provider for the authentication
   * test without forcing the test caller to manage that lifecycle.
   *
   * When omitted, authentication test is skipped.
   */
  providerWithKey?: (apiKey: string) => Provider;
}

const BAD_KEY = "sk-test-EC4-DELIBERATELY-INVALID";

export const runEC4: ECRunner & ((p: Provider, o?: EC4Options) => Promise<ECResult>) =
  async (provider: Provider, options?: EC4Options): Promise<ECResult> => {
    const models = options?.models ?? DEFAULT_MODELS;
    const triggers = options?.triggers ?? {};
    const t0 = Date.now();
    const perModel: ECPerModelOutcome[] = [];

    for (const [vendor, model] of Object.entries(models)) {
      perModel.push(await runOne(provider, model, vendor, triggers, options?.providerWithKey));
    }

    return {
      ec: "EC-4",
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
  triggers: EC4Triggers,
  providerWithKey: ((apiKey: string) => Provider) | undefined,
): Promise<ECPerModelOutcome> {
  const observed: Record<ProviderErrorCategory, "expected" | "missing" | "wrong-category" | "skipped"> = {
    authentication: "skipped",
    rate_limit: "skipped",
    model_not_found: "skipped",
    content_policy_refusal: "skipped",
    network_timeout: "skipped",
    schema_violation: "skipped",
    unknown: "skipped",
  };

  // Authentication
  if (triggers.testAuthentication !== false && providerWithKey) {
    const badProvider = providerWithKey(BAD_KEY);
    observed.authentication = await assertCategoryThrown(badProvider, "authentication", model);
  }

  // Rate limit
  if (triggers.testRateLimit) {
    observed.rate_limit = await assertCategoryThrown(
      provider,
      "rate_limit",
      triggers.testRateLimit.model,
    );
  }

  // Model not found
  if (triggers.testModelNotFound) {
    observed.model_not_found = await assertCategoryThrown(
      provider,
      "model_not_found",
      triggers.testModelNotFound.model,
    );
  }

  // Content-policy refusal — this should NOT throw; should return a
  // CompletionResult with finishReason='refusal' (per PB-7's "model refused
  // vs provider errored" distinction).
  if (triggers.testContentPolicyRefusal) {
    try {
      const result = await provider.complete({
        model,
        messages: [{ role: "user", content: triggers.testContentPolicyRefusal.prompt }],
        maxTokens: 64,
      });
      observed.content_policy_refusal =
        result.finishReason === "refusal" ? "expected" : "wrong-category";
    } catch (err) {
      // If it threw, the adapter is conflating refusal with error.
      observed.content_policy_refusal = isProviderError(err) ? "wrong-category" : "missing";
    }
  }

  // Network timeout
  if (triggers.testNetworkTimeout) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), triggers.testNetworkTimeout.timeoutMs);
    try {
      await provider.complete({
        model,
        messages: [{ role: "user", content: "long task" }],
        maxTokens: 4096,
        signal: ac.signal,
      });
      observed.network_timeout = "missing";
    } catch (err) {
      observed.network_timeout =
        isProviderError(err) && err.category === "network_timeout" ? "expected" : "wrong-category";
    } finally {
      clearTimeout(t);
    }
  }

  // Score: each "expected" is good; "wrong-category" / "missing" are failures;
  // "skipped" is neutral and reported.
  const checks: ProviderErrorCategory[] = [
    "authentication",
    "rate_limit",
    "model_not_found",
    "content_policy_refusal",
    "network_timeout",
  ];
  const summary = checks.map((c) => `${c}:${observed[c]}`).join(", ");
  const fails = checks.filter((c) => observed[c] === "missing" || observed[c] === "wrong-category");

  return {
    model,
    pass: fails.length === 0,
    notes: `vendor=${vendor}: ${summary}`,
    metric: { summary, fails: fails.length },
  };
}

async function assertCategoryThrown(
  provider: Provider,
  expected: ProviderErrorCategory,
  model: string,
): Promise<"expected" | "missing" | "wrong-category" | "skipped"> {
  try {
    await provider.complete({
      model,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 16,
    });
    return "missing";
  } catch (err) {
    if (!isProviderError(err)) return "missing";
    return err.category === expected ? "expected" : "wrong-category";
  }
}
