import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProviderError } from "@j-rig/core";
import type { ExecutionToolRuntime, ExecutionToolSession, ToolDefinition } from "@j-rig/core";
import { z } from "zod";

const Server = z
  .object({
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64).optional(),
    cwd: z.string().min(1).max(4096).optional(),
    env: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z_0-9]*$/))
      .max(64)
      .optional(),
    tools: z
      .array(z.string().regex(/^[A-Za-z_0-9]{1,40}$/))
      .min(1)
      .max(32),
  })
  .strict();
const Config = z
  .object({
    servers: z.record(z.string().regex(/^[A-Za-z][A-Za-z_0-9]{0,15}$/), Server),
    limits: z
      .object({
        maxTurns: z.number().int().min(1).max(32).optional(),
        maxCalls: z.number().int().min(1).max(64).optional(),
        maxResultBytes: z.number().int().min(1).max(1048576).optional(),
        maxTotalBytes: z.number().int().min(1).max(4194304).optional(),
        timeoutMs: z.number().int().min(1).max(300000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function failure(reason: string): ProviderError {
  return new ProviderError({
    category: "schema_violation",
    providerName: "mcp",
    message: `mcp/${reason}`,
    retryable: false,
  });
}

/** No config is discovered from SKILL.md or from a repository's ambient MCP files. */
export async function loadMcpRuntime(path: string): Promise<{
  runtime: ExecutionToolRuntime;
  fingerprint: string;
}> {
  let bytes: Buffer;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536) throw failure("configuration_invalid");
      bytes = await file.readFile();
      if (bytes.length > 65536) throw failure("configuration_invalid");
    } finally {
      await file.close();
    }
  } catch {
    throw failure("configuration_unavailable");
  }
  let config: z.infer<typeof Config>;
  try {
    config = Config.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw failure("configuration_invalid");
  }
  const servers = Object.entries(config.servers);
  if (!servers.length || servers.length > 8) throw failure("server_inventory");
  const limits = {
    maxTurns: 8,
    maxCalls: 32,
    maxResultBytes: 65536,
    maxTotalBytes: 1048576,
    timeoutMs: 60000,
    ...config.limits,
  };
  const prepared = servers.map(([name, server]) => {
    if (new Set(server.tools).size !== server.tools.length) throw failure("duplicate_tool");
    const env = getDefaultEnvironment();
    for (const key of server.env ?? []) {
      const value = process.env[key];
      if (value === undefined) throw failure("environment_unavailable");
      env[key] = value;
    }
    return { name, server, env, cwd: resolve(dirname(resolve(path)), server.cwd ?? ".") };
  });
  const runtime: ExecutionToolRuntime = {
    limits,
    async open(signal): Promise<ExecutionToolSession> {
      const sessionId = randomUUID();
      const clients: Client[] = [];
      const transports: StdioClientTransport[] = [];
      const aliases = new Map<string, { client: Client; tool: string }>();
      const tools: ToolDefinition[] = [];
      let closed = false;
      async function close(): Promise<void> {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled(clients.map((client) => client.close()));
        await Promise.all(transports.map((transport) => transport.close()));
        if (results.some((result) => result.status === "rejected")) throw failure("cleanup_failed");
      }
      try {
        for (const { name, server, env, cwd } of prepared) {
          signal.throwIfAborted();
          const client = new Client({ name: "jrig-eval", version: "1.0.0" });
          const transport = new StdioClientTransport({
            command: server.command,
            args: server.args ?? [],
            // This reserved correlation value is runtime-owned, even if the
            // explicit environment allowlist contains an ambient value for it.
            env: { ...env, JRIG_EXECUTION_SESSION_ID: sessionId },
            cwd,
            stderr: "ignore",
            maxBufferSize: 1048576,
          });
          clients.push(client);
          transports.push(transport);
          await client.connect(transport, { signal, timeout: limits.timeoutMs });
          const available = new Map<string, ToolDefinition>();
          let cursor: string | undefined;
          for (let page = 0; page < 8; page++) {
            const result = await client.listTools(cursor ? { cursor } : {}, {
              signal,
              timeout: limits.timeoutMs,
            });
            for (const tool of result.tools) {
              if (available.has(tool.name) || available.size >= 256)
                throw failure("tool_inventory");
              available.set(tool.name, {
                name: tool.name,
                description: tool.description ?? "",
                inputSchema: tool.inputSchema,
              });
            }
            cursor = result.nextCursor;
            if (!cursor) break;
          }
          if (cursor) throw failure("tool_inventory");
          for (const name_ of server.tools) {
            const tool = available.get(name_);
            const alias = `${name}__${name_}`;
            if (!tool || aliases.has(alias)) throw failure("tool_inventory");
            aliases.set(alias, { client, tool: name_ });
            tools.push({ ...tool, name: alias });
            if (Buffer.byteLength(JSON.stringify(tools)) > Math.min(limits.maxTotalBytes, 262144)) {
              throw failure("tool_definitions_too_large");
            }
          }
        }
      } catch {
        await close();
        throw failure(signal.aborted ? "initialization_cancelled" : "initialization_failed");
      }
      return {
        sessionId,
        tools,
        async call(name, args, callSignal): Promise<string> {
          const target = aliases.get(name);
          if (closed || !target) throw failure("tool_unavailable");
          try {
            const result = await target.client.callTool(
              { name: target.tool, arguments: args },
              undefined,
              { signal: callSignal, timeout: limits.timeoutMs },
            );
            // Preserve structured content and isError for model correction. The loop
            // bounds all returned bytes before feeding this result to the model.
            return JSON.stringify(result);
          } catch {
            throw failure(callSignal.aborted ? "call_cancelled" : "call_failed");
          }
        },
        close,
      };
    },
  };
  return { runtime, fingerprint: createHash("sha256").update(bytes).digest("hex") };
}
