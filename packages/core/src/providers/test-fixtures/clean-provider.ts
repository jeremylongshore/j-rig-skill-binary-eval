/**
 * CleanProvider — a Provider implementation that PASSES both CISO gates.
 *
 * Used as a reference baseline for the LiteLLM + Vercel AI SDK prototypes.
 * If your adapter cannot pass G-1 and G-2 against this fixture's behavior,
 * your adapter has a credential-handling defect.
 *
 * Behavior:
 *   - Never logs anything (no stdout/stderr writes)
 *   - Never spawns subprocesses
 *   - Reads the API key only at instance-construction time; does not echo
 *     it anywhere after that
 *   - Returns deterministic synthetic CompletionResults (no network call)
 *
 * Use only in tests / gate-validation runs. NOT a production provider.
 */
import { ProviderError } from "../errors.js";
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  StreamChunk,
  ToolCallResult,
  ToolDefinition,
} from "../types.js";

export class CleanProvider implements Provider {
  readonly name = "clean-test-provider";
  readonly version = "0.0.0";

  // Private; never exposed in error messages or returned values.
  readonly #apiKey: string;

  constructor(opts: { apiKey: string }) {
    this.#apiKey = opts.apiKey;
    // Side effect: NONE. No logs, no spawn.
    // The mere act of constructing this provider must not leak the key.
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.#apiKey.length < 8) {
      throw new ProviderError({
        category: "authentication",
        providerName: this.name,
        message: "apiKey too short",
      });
    }
    return {
      text: `[clean-provider synthetic response to '${req.messages.at(-1)?.content ?? "<empty>"}']`,
      model: req.model,
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: "stop",
    };
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const text = `[clean-provider synthetic stream: ${req.model}]`;
    yield { type: "text_delta", delta: text };
    yield {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async callTool(
    req: CompletionRequest & { tools: ToolDefinition[] },
  ): Promise<ToolCallResult> {
    const t = req.tools[0];
    return {
      toolName: t?.name ?? null,
      toolArguments: t ? {} : null,
      toolCallId: t ? "clean-tc-1" : null,
      text: "",
      finishReason: t ? "tool_use" : "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async batch(reqs: CompletionRequest[]): Promise<Array<CompletionResult | ProviderError>> {
    return Promise.all(reqs.map((r) => this.complete(r)));
  }
}
