import { describe, expect, it, vi } from "vitest";
import type { ExecutionToolRuntime, Provider, ToolCallResult } from "@j-rig/core";
import { executeWithTools } from "./tool-execution.js";

function fixture() {
  const call = vi.fn(async () => "tool result");
  const close = vi.fn(async () => {});
  const runtime: ExecutionToolRuntime = {
    open: async () => ({
      sessionId: "session-fixture",
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
      call,
      close,
    }),
    limits: {
      maxTurns: 3,
      maxCalls: 3,
      maxResultBytes: 1000,
      maxTotalBytes: 2000,
      timeoutMs: 1000,
    },
  };
  const result: ToolCallResult = {
    text: "done",
    finishReason: "stop",
    toolName: null,
    toolArguments: null,
    toolCallId: null,
    usage: null,
  };
  const provider: Provider = {
    name: "fixture",
    version: "1.0.0",
    complete: vi.fn(),
    completeStream: vi.fn(),
    batch: vi.fn(),
    callTool: vi.fn(async () => result),
  };
  const request = { model: "fixture", messages: [] };
  return { call, close, runtime, result, provider, request };
}

describe("tool execution failure receipts", () => {
  it("refuses an otherwise complete answer when cleanup fails", async () => {
    const { call, close, runtime, provider, request } = fixture();
    close.mockRejectedValue(new Error("private cleanup detail"));
    await expect(executeWithTools(provider, request, runtime)).rejects.toMatchObject({
      message: "tool_execution/cleanup_failed",
      toolCalls: 0,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ filename: "tool-events.json", content: "[]" }),
      ]),
    });
    expect(call).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves turn validation failure over a later cleanup failure", async () => {
    const { call, close, runtime, result, provider, request } = fixture();
    result.finishReason = "tool_use";
    result.toolCalls = [
      { id: "one", name: "echo", arguments: {} },
      { id: "one", name: "echo", arguments: {} },
    ];
    close.mockRejectedValue(new Error("private cleanup detail"));
    await expect(executeWithTools(provider, request, runtime)).rejects.toMatchObject({
      message: "tool_execution/invalid_tool_call",
      toolCalls: 0,
    });
    expect(call).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("removes an oversized started observation before invoking its effect", async () => {
    const { call, close, runtime, result, provider, request } = fixture();
    runtime.judgeObservations = { redact: (text) => text };
    runtime.limits.maxTotalBytes = 300;
    result.text = "";
    result.finishReason = "tool_use";
    result.toolCalls = [{ id: "one", name: "echo", arguments: { text: "x".repeat(180) } }];
    await expect(executeWithTools(provider, request, runtime)).rejects.toMatchObject({
      message: "tool_execution/observation_limit",
      toolCalls: 0,
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          filename: "tool-observations.json",
          content: JSON.stringify({
            schema: "jrig-tool-observations/v1",
            session_id: "session-fixture",
            redaction: "known-environment-credentials-and-credential-fields/v1",
            calls: [],
          }),
        }),
      ]),
    });
    expect(call).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("redacts an unexpected transport error and retains the attempted effect", async () => {
    const { call, close, runtime, result, provider, request } = fixture();
    result.finishReason = "tool_use";
    result.toolCalls = [{ id: "one", name: "echo", arguments: {} }];
    call.mockRejectedValue(new Error("private transport detail"));
    await expect(executeWithTools(provider, request, runtime)).rejects.toMatchObject({
      message: "tool_execution/transport_failed",
      toolCalls: 1,
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          filename: "tool-events.json",
          content: '[{"tool":"echo","status":"started"}]',
        }),
      ]),
    });
    expect(call).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
