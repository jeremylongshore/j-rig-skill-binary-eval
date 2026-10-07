import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadMcpRuntime } from "./mcp-runtime.js";
import {
  RealOpenAICompatProvider,
  OpenAICompatExecutionProvider,
} from "../providers/openai-compatible.js";
import { RealAnthropicProvider, AnthropicExecutionProvider } from "../providers/anthropic-real.js";
import type { Transport, TransportRequest } from "../providers/transport.js";

const fixture = fileURLToPath(new URL("./__fixtures__/mcp-server.mjs", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup(tools = ["echo"], limits: Record<string, number> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jrig-mcp-"));
  directories.push(directory);
  vi.stubEnv("MCP_FIXTURE_DIR", directory);
  vi.stubEnv("MCP_UNAPPROVED_SECRET", "synthetic-private-value");
  const path = join(directory, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      servers: {
        fixture: {
          command: process.execPath,
          args: [fixture],
          env: ["MCP_FIXTURE_DIR"],
          tools,
        },
      },
      limits,
    }),
  );
  const loaded = await loadMcpRuntime(path);
  return { ...loaded, directory };
}
function openaiResponse(calls?: { name: string; id: string; args: object }[]) {
  return {
    status: 200,
    json: {
      choices: [
        {
          finish_reason: calls ? "tool_calls" : "stop",
          message: {
            content: calls ? "" : "grounded final answer",
            ...(calls
              ? {
                  tool_calls: calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  })),
                }
              : {}),
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  };
}
function execution(transport: Transport) {
  return new OpenAICompatExecutionProvider(
    "fixture-model",
    new RealOpenAICompatProvider({
      apiKey: "synthetic-key-only",
      baseUrl: "https://unused.invalid",
      transport,
    }),
  );
}
async function assertStopped(directory: string) {
  const pid = Number(await readFile(join(directory, "pid"), "utf8"));
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
}

describe("explicit stdio MCP execution", () => {
  it("generates a fresh correlation identity per session and overrides ambient substitution", async () => {
    const { directory } = await setup();
    vi.stubEnv("JRIG_EXECUTION_SESSION_ID", "ambient-value-must-not-win");
    const configPath = join(directory, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.servers.fixture.env.push("JRIG_EXECUTION_SESSION_ID");
    await writeFile(configPath, JSON.stringify(config));
    const { runtime } = await loadMcpRuntime(configPath);
    const first = await runtime.open(new AbortController().signal);
    const firstId = first.sessionId;
    const firstTools = first.tools;
    await first.close();
    const second = await runtime.open(new AbortController().signal);
    try {
      expect(firstId).toMatch(/^[a-f0-9-]{36}$/);
      expect(second.sessionId).toMatch(/^[a-f0-9-]{36}$/);
      expect(firstId).not.toBe(second.sessionId);
      expect(second.tools).toEqual(firstTools);
      const observed = (await readFile(join(directory, "session-identities"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(observed.map((entry) => entry.session_id)).toEqual([firstId, second.sessionId]);
      expect(JSON.stringify(observed)).not.toContain("ambient-value-must-not-win");
    } finally {
      await second.close();
    }
    await assertStopped(directory);
  });
  it("refuses a truncated model turn even when its tool arguments parse", async () => {
    const { runtime, directory } = await setup();
    const provider = execution(async () => {
      const response = openaiResponse([{ id: "a", name: "fixture__echo", args: { text: "a" } }]);
      response.json.choices[0]!.finish_reason = "length";
      return response;
    });
    await expect(
      provider.execute("Fixture", { skill_body: "Skill", tool_runtime: runtime }),
    ).rejects.toMatchObject({ message: "tool_execution/incomplete_response", toolCalls: 0 });
    await expect(readFile(join(directory, "calls"))).rejects.toMatchObject({ code: "ENOENT" });
    await assertStopped(directory);
  });
  it.each([
    [
      "duplicate identifiers",
      [
        { id: "same", name: "fixture__echo", args: { text: "a" } },
        { id: "same", name: "fixture__echo", args: { text: "b" } },
      ],
    ],
    ["non-object arguments", [{ id: "a", name: "fixture__echo", args: [] }]],
    [
      "call cap",
      [
        { id: "a", name: "fixture__echo", args: { text: "a" } },
        { id: "b", name: "fixture__echo", args: { text: "b" } },
      ],
    ],
  ] as const)("refuses %s before any tool effect", async (_reason, calls) => {
    const { runtime, directory } = await setup(["echo"], { maxCalls: 1 });
    const provider = execution(async () => openaiResponse([...calls]));
    await expect(
      provider.execute("Fixture", { skill_body: "Skill", tool_runtime: runtime }),
    ).rejects.toMatchObject({ category: "schema_violation", toolCalls: 0 });
    await expect(readFile(join(directory, "calls"))).rejects.toMatchObject({ code: "ENOENT" });
    await assertStopped(directory);
  });

  it("closes an initialized server if an allowlisted tool is missing", async () => {
    const { runtime, directory } = await setup(["missing"]);
    const provider = execution(async () => {
      throw new Error("model must not be called");
    });
    await expect(
      provider.execute("Fixture", { skill_body: "Skill", tool_runtime: runtime }),
    ).rejects.toMatchObject({ message: "mcp/initialization_failed", toolCalls: 0 });
    await assertStopped(directory);
  });

  it("refuses malformed MCP results and closes the process", async () => {
    const { runtime, directory } = await setup(["malformed"]);
    let turns = 0;
    const provider = execution(async () => {
      turns++;
      return openaiResponse([{ id: "a", name: "fixture__malformed", args: {} }]);
    });
    await expect(
      provider.execute("Fixture", { skill_body: "Skill", tool_runtime: runtime }),
    ).rejects.toMatchObject({ message: "mcp/call_failed", toolCalls: 1 });
    expect(turns).toBe(1);
    await assertStopped(directory);
  });

  it("rejects invalid configuration and unavailable explicit environment before launching", async () => {
    const { directory } = await setup();
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        servers: { fixture: { command: process.execPath, tools: ["echo"], unknown: true } },
      }),
    );
    await expect(loadMcpRuntime(path)).rejects.toMatchObject({
      message: "mcp/configuration_invalid",
    });
    vi.stubEnv("MCP_FIXTURE_MISSING", undefined);
    await writeFile(
      path,
      JSON.stringify({
        servers: {
          fixture: { command: process.execPath, tools: ["echo"], env: ["MCP_FIXTURE_MISSING"] },
        },
      }),
    );
    await expect(loadMcpRuntime(path)).rejects.toMatchObject({
      message: "mcp/environment_unavailable",
    });
    await expect(readFile(join(directory, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes every call, preserves wire correlation, scopes env and closes a real server", async () => {
    const { runtime, directory } = await setup();
    const requests: TransportRequest[] = [];
    const provider = execution(async (request) => {
      requests.push(request);
      return requests.length === 1
        ? openaiResponse([
            { id: "one", name: "fixture__echo", args: { text: "first" } },
            { id: "two", name: "fixture__echo", args: { text: "second" } },
          ])
        : openaiResponse();
    });
    const result = await provider.execute("Use the fixture", {
      skill_body: "Fixture skill",
      tool_runtime: runtime,
    });
    expect(result.text).toBe("grounded final answer");
    expect(result.tool_calls).toBe(2);
    const first = requests[0]!.body as { tools: { function: { name: string } }[] };
    expect(first.tools.map((tool) => tool.function.name)).toEqual(["fixture__echo"]);
    const second = requests[1]!.body as {
      messages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }[];
    };
    const responseMessages = second.messages.filter((message) => message.role === "tool");
    expect(responseMessages.map((message) => message.tool_call_id)).toEqual(["one", "two"]);
    expect(responseMessages[0]!.content).toContain("ambient_secret_inherited");
    const payload = JSON.parse(responseMessages[0]!.content) as { content: { text: string }[] };
    expect(JSON.parse(payload.content[0]!.text)).toMatchObject({
      text: "first",
      ambient_secret_inherited: false,
    });
    expect(
      second.messages.find((message) => message.role === "assistant")!.tool_calls,
    ).toHaveLength(2);
    expect(result.artifacts[0]!.content).not.toContain("first");
    expect((await readFile(join(directory, "calls"), "utf8")).trim().split("\n")).toEqual([
      "echo",
      "echo",
    ]);
    await assertStopped(directory);
  });

  it("uses Anthropic tool_use/tool_result turns with the same stdio runtime", async () => {
    const { runtime, directory } = await setup();
    const requests: TransportRequest[] = [];
    const provider = new AnthropicExecutionProvider(
      "sonnet",
      new RealAnthropicProvider({
        apiKey: "synthetic-key-only",
        transport: async (request) => {
          requests.push(request);
          return {
            status: 200,
            json: {
              content:
                requests.length === 1
                  ? [
                      { type: "tool_use", id: "a", name: "fixture__echo", input: { text: "one" } },
                      { type: "tool_use", id: "b", name: "fixture__echo", input: { text: "two" } },
                    ]
                  : [{ type: "text", text: "finished" }],
              stop_reason: requests.length === 1 ? "tool_use" : "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
        },
      }),
    );
    const result = await provider.execute(
      "Fixture",
      { skill_body: "Skill", tool_runtime: runtime },
      { temperature: 0 },
    );
    expect(result.tool_calls).toBe(2);
    expect(result.text).toBe("finished");
    expect(JSON.stringify(requests[1]!.body)).toContain('"tool_use_id":"b"');
    expect(JSON.stringify(requests[1]!.body)).toContain('"type":"tool_use"');
    expect(requests[0]!.body).toMatchObject({ temperature: 0 });
    await assertStopped(directory);
  });

  it("refuses an unallowed tool before any effect", async () => {
    const { runtime, directory } = await setup();
    const provider = execution(async () =>
      openaiResponse([{ id: "bad", name: "fixture__hidden", args: {} }]),
    );
    await expect(
      provider.execute("Fixture", { skill_body: "Skill", tool_runtime: runtime }),
    ).rejects.toMatchObject({ message: "tool_execution/invalid_tool_call", toolCalls: 0 });
    await expect(readFile(join(directory, "calls"))).rejects.toMatchObject({ code: "ENOENT" });
    await assertStopped(directory);
  });

  it("bounds turns, retains partial evidence and closes the session", async () => {
    const { runtime, directory } = await setup(["echo"], { maxTurns: 1 });
    const provider = execution(async () =>
      openaiResponse([{ id: "a", name: "fixture__echo", args: { text: "one" } }]),
    );
    await expect(
      provider.execute("Fixture", { skill_body: "Skill", tool_runtime: runtime }),
    ).rejects.toMatchObject({ message: "tool_execution/turn_limit", toolCalls: 1 });
    await assertStopped(directory);
  });

  it("bounds output without feeding an oversized result back to the model", async () => {
    const { runtime, directory } = await setup(["echo"], { maxResultBytes: 16 });
    let turns = 0;
    const provider = execution(async () => {
      turns++;
      return openaiResponse([{ id: "a", name: "fixture__echo", args: { text: "x".repeat(256) } }]);
    });
    await expect(
      provider.execute("Fixture", { skill_body: "Skill", tool_runtime: runtime }),
    ).rejects.toMatchObject({ message: "tool_execution/output_limit", toolCalls: 1 });
    expect(turns).toBe(1);
    await assertStopped(directory);
  });

  it("cancels an active tool call and cleans up", async () => {
    const { runtime, directory } = await setup(["hang"], { timeoutMs: 1500 });
    const provider = execution(async () =>
      openaiResponse([{ id: "a", name: "fixture__hang", args: {} }]),
    );
    await expect(
      provider.execute("Fixture", { skill_body: "Skill", tool_runtime: runtime }),
    ).rejects.toMatchObject({ category: "network_timeout", toolCalls: 1 });
    await assertStopped(directory);
  }, 10000);

  it("redacts transport failure while retaining the attempted-call count", async () => {
    const { runtime, directory } = await setup(["crash"]);
    const provider = execution(async () =>
      openaiResponse([{ id: "a", name: "fixture__crash", args: {} }]),
    );
    await expect(
      provider.execute("Fixture", { skill_body: "Skill", tool_runtime: runtime }),
    ).rejects.toMatchObject({ message: "mcp/call_failed", toolCalls: 1 });
    await assertStopped(directory);
  });
});
