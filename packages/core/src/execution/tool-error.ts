import { ProviderError } from "../providers/errors.js";
import type { ArtifactRecord } from "./types.js";

/** Preserve safe partial execution evidence when a tool-enabled run fails. */
export class ToolExecutionError extends ProviderError {
  constructor(
    failure: ProviderError,
    readonly toolCalls: number,
    readonly artifacts: ArtifactRecord[],
  ) {
    super({
      category: failure.category,
      providerName: failure.providerName,
      retryable: failure.retryable,
      message: failure.message,
    });
  }
}
