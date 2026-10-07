import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createDatabase } from "@j-rig/db";
import { EvidenceStatementSchema } from "@j-rig/core";
import { parse, stringify } from "yaml";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const skill = fileURLToPath(new URL("../../../../skill", import.meta.url));
const fixture = fileURLToPath(new URL("../execution/__fixtures__/mcp-server.mjs", import.meta.url));
interface Request {
  tools?: { function: { name: string } }[];
  messages: { role: string; content: string; tool_call_id?: string }[];
}

describe("eval with a real MCP child and local HTTP model fixture", { timeout: 30000 }, () => {
  it.each([false, true])(
    "persists execution and isolated baseline evidence (crash=%s)",
    async (crash) => {
      const directory = mkdtempSync(join(tmpdir(), "jrig-cli-mcp-"));
      const requests: Request[] = [];
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Request;
        requests.push(body);
        const toolResults = body.messages.filter((message) => message.role === "tool");
        const needsTool = body.tools && !toolResults.length;
        const content = body.tools
          ? "grounded fixture answer"
          : JSON.stringify({ verdict: "yes", confidence: 1, reasoning: "fixture judgment" });
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: needsTool ? "tool_calls" : "stop",
                message: needsTool
                  ? {
                      content: "",
                      tool_calls: [
                        {
                          id: "call-1",
                          type: "function",
                          function: {
                            name: crash ? "fixture__crash" : "fixture__echo",
                            arguments: JSON.stringify(crash ? {} : { text: "fixture input" }),
                          },
                        },
                      ],
                    }
                  : { content },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing fixture address");
        const spec = parse(readFileSync(join(skill, "eval.yaml"), "utf8"));
        spec.test_cases = [spec.test_cases[0]];
        spec.criteria = [spec.criteria[1]];
        spec.test_cases[0].criteria_ids = [spec.criteria[0].id];
        const specPath = join(directory, "eval.yaml");
        writeFileSync(specPath, stringify(spec));
        const configPath = join(directory, "mcp.json");
        writeFileSync(
          configPath,
          JSON.stringify({
            servers: {
              fixture: {
                command: process.execPath,
                args: [fixture],
                env: ["MCP_FIXTURE_DIR"],
                tools: [crash ? "crash" : "echo"],
              },
            },
          }),
        );
        const dbPath = join(directory, "run.db");
        const bundlePath = join(directory, "bundle.json");
        let exitCode = 0;
        try {
          await promisify(execFile)(
            process.execPath,
            [
              cli,
              "eval",
              skill,
              "--spec",
              specPath,
              "--provider",
              "openai",
              "--models",
              "fixture-model",
              "--no-trigger",
              "--baseline-check",
              "--samples",
              "1",
              "--mcp-config",
              configPath,
              "--db",
              dbPath,
              "--emit-bundle",
              bundlePath,
              "--json",
            ],
            {
              timeout: 25000,
              env: {
                PATH: process.env.PATH,
                OPENAI_API_KEY: "synthetic-fixture-key",
                LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
                LLM_MODEL: "fixture-model",
                MCP_FIXTURE_DIR: directory,
              },
            },
          );
        } catch (error) {
          if (!crash) throw error;
          exitCode = (error as { code: number }).code;
        }
        expect(exitCode).toBe(crash ? 2 : 0);
        const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
        expect(EvidenceStatementSchema.safeParse(bundle[0]).success).toBe(true);
        if (crash) expect(bundle[0].predicate.gate_decision).toBe("error");
        const metadata = bundle[0].predicate.metadata.tool_execution;
        expect(metadata.receipts).toHaveLength(2);
        expect(
          metadata.receipts.map(
            (receipt: { attempted_tool_calls: number }) => receipt.attempted_tool_calls,
          ),
        ).toEqual([1, 1]);
        const childIdentities = readFileSync(join(directory, "session-identities"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { pid: number; session_id: string });
        const receiptIdentities: string[] = [];
        const database = createDatabase(dbPath);
        try {
          const artifacts = database.sqlite
            .prepare("SELECT * FROM artifacts WHERE artifact_type = 'tool-execution'")
            .all() as { relative_path: string; sha256: string }[];
          expect(artifacts).toHaveLength(2);
          for (const artifact of artifacts) {
            const bytes = readFileSync(artifact.relative_path);
            expect(artifact.sha256).toBe(
              "sha256:" + createHash("sha256").update(bytes).digest("hex"),
            );
            expect(
              metadata.receipts.map((receipt: { sha256: string }) => receipt.sha256),
            ).toContain(artifact.sha256);
            expect(statSync(artifact.relative_path).mode & 0o777).toBe(0o600);
            const receipt = JSON.parse(bytes.toString());
            expect(receipt.cases[0].output.tool_calls).toBe(1);
            expect(receipt.cases[0].status).toBe(crash ? "failed" : "completed");
            expect(receipt.cases[0].output.text).toBe(crash ? "" : "grounded fixture answer");
            expect(receipt.cases[0].output.artifacts[0].filename).toBe("tool-events.json");
            const identity = receipt.cases[0].output.artifacts.find(
              (entry: { filename: string }) => entry.filename === "tool-session.json",
            );
            expect(identity).toBeDefined();
            expect(identity.size_bytes).toBe(Buffer.byteLength(identity.content));
            const parsedIdentity = JSON.parse(identity.content);
            expect(parsedIdentity.schema).toBe("jrig-tool-session/v1");
            expect(
              childIdentities.filter((entry) => entry.session_id === parsedIdentity.session_id),
            ).toHaveLength(1);
            receiptIdentities.push(parsedIdentity.session_id);
            expect(bytes.toString()).not.toContain("synthetic-private-stderr");
          }
        } finally {
          database.sqlite.close();
        }
        expect(new Set(receiptIdentities).size).toBe(2);
        expect(new Set(childIdentities.map((entry) => entry.session_id)).size).toBe(2);
        const judges = requests.filter((request) => !request.tools);
        expect(judges).toHaveLength(crash ? 0 : 2);
        for (const judge of judges) {
          expect(judge.messages.some((message) => message.role === "tool")).toBe(false);
          expect(judge.messages[0]!.content).toContain("strict binary evaluator");
        }
        const executions = requests.filter((request) => request.tools);
        expect(executions).toHaveLength(crash ? 2 : 4);
        expect(executions[0]!.tools).toEqual(executions.at(-1)!.tools);
        expect(executions[0]!.messages[0]!.content.length).toBeGreaterThan(0);
        expect(executions.at(-1)!.messages[0]!.content).toBe("");
        const pids = readFileSync(join(directory, "pids"), "utf8").trim().split("\n").map(Number);
        expect(new Set(pids).size).toBe(2);
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
