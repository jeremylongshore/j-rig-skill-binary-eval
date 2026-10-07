import { ProviderError, ToolExecutionError } from "@j-rig/core";
import type {
  ArtifactRecord,
  ChatMessage,
  CompletionRequest,
  ExecutionToolRuntime,
  ExecutionToolSession,
  ModelToolCall,
  Provider,
} from "@j-rig/core";

function refusal(reason: string, timeout = false): ProviderError {
  return new ProviderError({
    category: timeout ? "network_timeout" : "schema_violation",
    providerName: "mcp",
    message: `tool_execution/${reason}`,
    retryable: false,
  });
}

export function modelToolCall(
  providerName: string,
  id: unknown,
  name: unknown,
  args: unknown,
): ModelToolCall {
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 256 ||
    typeof name !== "string" ||
    !name ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  ) {
    throw new ProviderError({
      category: "schema_violation",
      providerName,
      message: "invalid_tool_call",
    });
  }
  return { id, name, arguments: args as Record<string, unknown> };
}

/** Model and tool text stays in the conversation; receipts retain counts only. */
export async function executeWithTools(
  provider: Provider,
  request: CompletionRequest,
  runtime: ExecutionToolRuntime,
): Promise<{ text: string; tool_calls: number; artifacts: ArtifactRecord[] }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) abort();
  const timer = setTimeout(abort, runtime.limits.timeoutMs);
  const signal = controller.signal;
  const events: { tool: string; status: "started" | "completed"; result_bytes?: number }[] = [];
  const artifacts = (): ArtifactRecord[] => {
    const content = JSON.stringify(events);
    const records: ArtifactRecord[] = [
      {
        filename: "tool-events.json",
        type: "text",
        content,
        size_bytes: Buffer.byteLength(content),
      },
    ];
    if (session?.sessionId) {
      const identity = JSON.stringify({
        schema: "jrig-tool-session/v1",
        session_id: session.sessionId,
      });
      records.push({
        filename: "tool-session.json",
        type: "text",
        content: identity,
        size_bytes: Buffer.byteLength(identity),
      });
    }
    return records;
  };
  let session: ExecutionToolSession | undefined;
  let calls = 0;
  let totalBytes = 0;
  let failure: unknown;
  let answer: string | undefined;
  // Only implementations honoring AbortSignal are admitted through this port.
  try {
    signal.throwIfAborted();
    session = await runtime.open(signal);
    const names = new Set(session.tools.map((tool) => tool.name));
    if (!names.size || names.size !== session.tools.length) throw refusal("tool_inventory");
    const messages: ChatMessage[] = request.messages.map((message) => ({ ...message }));
    const ids = new Set<string>();
    for (let turn = 0; turn < runtime.limits.maxTurns; turn++) {
      signal.throwIfAborted();
      const result = await provider.callTool({
        ...request,
        messages,
        tools: session.tools,
        signal,
      });
      signal.throwIfAborted();
      totalBytes += Buffer.byteLength(result.text);
      if (totalBytes > runtime.limits.maxTotalBytes) throw refusal("output_limit");
      if (result.finishReason === "length" || result.finishReason === "error")
        throw refusal("incomplete_response");
      const requested: ModelToolCall[] =
        result.toolCalls ??
        (result.toolName === null
          ? []
          : [
              {
                id: result.toolCallId ?? "",
                name: result.toolName,
                arguments: result.toolArguments ?? {},
              },
            ]);
      if (!requested.length) {
        if (result.finishReason === "tool_use") throw refusal("missing_tool_call");
        answer = result.text;
        break;
      }
      if (result.finishReason !== "tool_use") throw refusal("unexpected_tool_call");
      // Validate the entire turn before invoking any effect.
      for (const call of requested) {
        if (
          !call.id ||
          ids.has(call.id) ||
          !names.has(call.name) ||
          !call.arguments ||
          typeof call.arguments !== "object" ||
          Array.isArray(call.arguments)
        ) {
          throw refusal("invalid_tool_call");
        }
        ids.add(call.id);
        totalBytes += Buffer.byteLength(JSON.stringify(call.arguments));
      }
      if (
        calls + requested.length > runtime.limits.maxCalls ||
        totalBytes > runtime.limits.maxTotalBytes
      ) {
        throw refusal("call_or_output_limit");
      }
      messages.push({ role: "assistant", content: result.text, toolCalls: requested });
      for (const call of requested) {
        signal.throwIfAborted();
        calls++;
        const event: (typeof events)[number] = { tool: call.name, status: "started" };
        events.push(event);
        const output = await session.call(call.name, call.arguments, signal);
        signal.throwIfAborted();
        const bytes = Buffer.byteLength(output);
        totalBytes += bytes;
        if (bytes > runtime.limits.maxResultBytes || totalBytes > runtime.limits.maxTotalBytes)
          throw refusal("output_limit");
        event.status = "completed";
        event.result_bytes = bytes;
        messages.push({ role: "tool", content: output, toolName: call.name, toolCallId: call.id });
      }
    }
    if (answer === undefined) throw refusal("turn_limit");
  } catch (error) {
    failure = signal.aborted
      ? refusal("timeout", true)
      : error instanceof ProviderError
        ? error
        : refusal("transport_failed");
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
    if (session) {
      try {
        await session.close();
      } catch {
        failure ??= refusal("cleanup_failed");
      }
    }
  }
  if (failure) {
    throw new ToolExecutionError(
      failure instanceof ProviderError ? failure : refusal("transport_failed"),
      calls,
      artifacts(),
    );
  }
  return { text: answer!, tool_calls: calls, artifacts: artifacts() };
}
