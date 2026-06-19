/**
 * LeakyProvider — a Provider implementation that DELIBERATELY FAILS both
 * CISO gates. Used in unit tests to confirm the gate runners detect failures.
 *
 * Failure modes:
 *   - G-1 trigger: writes the api key to stderr on construction and on
 *     each call (the kind of "debug logging" pattern that real providers
 *     sometimes ship and we want to catch).
 *   - G-2 trigger: spawns a subprocess (a no-op `node -e` invocation) with
 *     the api key passed through in `options.env`.
 *
 * This fixture MUST be in tests/CI only. It is intentionally insecure.
 */
import child_process from "node:child_process";
import { ProviderError } from "../errors.js";
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  StreamChunk,
  ToolCallResult,
  ToolDefinition,
} from "../types.js";

export class LeakyProvider implements Provider {
  readonly name = "leaky-test-provider";
  readonly version = "0.0.0";

  readonly #apiKey: string;
  readonly #leakStdout: boolean;
  readonly #leakSpawn: boolean;

  constructor(opts: { apiKey: string; leakStdout?: boolean; leakSpawn?: boolean }) {
    this.#apiKey = opts.apiKey;
    this.#leakStdout = opts.leakStdout ?? true;
    this.#leakSpawn = opts.leakSpawn ?? true;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.#leakStdout) {
      // G-1 failure mode: emit the key on stderr
      process.stderr.write(`[leaky-provider DEBUG] using key=${this.#apiKey}\n`);
    }
    if (this.#leakSpawn) {
      // G-2 failure mode: spawn a child with the key in env
      child_process.spawnSync("node", ["-e", "process.exit(0)"], {
        env: { ...process.env, LEAKY_API_KEY: this.#apiKey },
        stdio: "ignore",
      });
    }
    if (this.#apiKey.length < 8) {
      throw new ProviderError({
        category: "authentication",
        providerName: this.name,
        message: "apiKey too short",
      });
    }
    return {
      text: `[leaky-provider synthetic: ${req.messages.at(-1)?.content ?? ""}]`,
      model: req.model,
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: "stop",
    };
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    if (this.#leakStdout) {
      process.stderr.write(`[leaky-provider DEBUG] stream key=${this.#apiKey}\n`);
    }
    yield { type: "text_delta", delta: `[leaky stream ${req.model}]` };
    yield {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async callTool(req: CompletionRequest & { tools: ToolDefinition[] }): Promise<ToolCallResult> {
    if (this.#leakStdout) {
      process.stderr.write(`[leaky-provider DEBUG] callTool key=${this.#apiKey}\n`);
    }
    const t = req.tools[0];
    return {
      toolName: t?.name ?? null,
      toolArguments: t ? {} : null,
      toolCallId: t ? "leaky-tc-1" : null,
      text: "",
      finishReason: t ? "tool_use" : "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async batch(reqs: CompletionRequest[]): Promise<Array<CompletionResult | ProviderError>> {
    return Promise.all(reqs.map((r) => this.complete(r)));
  }
}
