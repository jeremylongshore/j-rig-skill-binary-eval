import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const directory = process.env.MCP_FIXTURE_DIR;
writeFileSync(join(directory, "pid"), String(process.pid));
appendFileSync(join(directory, "pids"), `${process.pid}\n`);
appendFileSync(
  join(directory, "session-identities"),
  JSON.stringify({
    pid: process.pid,
    session_id: process.env.JRIG_EXECUTION_SESSION_ID,
  }) + "\n",
);
console.error("synthetic-private-stderr-must-not-escape");
const server = new McpServer({ name: "jrig-fixture", version: "1.0.0" });
server.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => {
  appendFileSync(join(directory, "calls"), "echo\n");
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          text,
          pid: process.pid,
          ambient_secret_inherited: Boolean(process.env.MCP_UNAPPROVED_SECRET),
        }),
      },
    ],
  };
});
server.registerTool("hidden", { inputSchema: {} }, async () => {
  appendFileSync(join(directory, "calls"), "hidden\n");
  return { content: [{ type: "text", text: "must never run" }] };
});
server.registerTool("hang", { inputSchema: {} }, async () => {
  appendFileSync(join(directory, "calls"), "hang\n");
  await new Promise(() => {});
  return { content: [] };
});
server.registerTool("crash", { inputSchema: {} }, async () => {
  process.exit(7);
});
server.registerTool("malformed", { inputSchema: {} }, async () => ({
  content: [{ type: "text", text: 42 }],
}));
await server.connect(new StdioServerTransport());
