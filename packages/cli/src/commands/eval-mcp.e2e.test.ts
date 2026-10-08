import { loadSkillEvalSpec } from "../lib/loaders.js";
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
import { EvidenceStatementSchema, hashCanonicalJson } from "@j-rig/core";
import { parse, stringify } from "yaml";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const skill = fileURLToPath(new URL("../../../../skill", import.meta.url));
const fixture = fileURLToPath(new URL("../execution/__fixtures__/mcp-server.mjs", import.meta.url));
interface Request {
  reasoning_effort?: string;
  tools?: { function: { name: string } }[];
  messages: { role: string; content: string; tool_call_id?: string }[];
}

describe("eval with a real MCP child and local HTTP model fixture", { timeout: 30000 }, () => {
  it.each([
    [false, false, null, undefined],
    [true, false, null, undefined],
    [false, true, null, undefined],
    [true, true, null, undefined],
    [true, true, "invalid_tool_call", undefined],
    [true, true, "incomplete_response", undefined],
    [false, true, null, "none"],
    [true, true, "invalid_tool_call", "low"],
    [true, true, "incomplete_response", "medium"],
  ] as const)("%s %s %s %s", async (crash, observations, refusal, effort) => {
    const directory = mkdtempSync(join(tmpdir(), "jrig-cli-mcp-"));
    const requests: Request[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Request;
      requests.push(body);
      const toolResults = body.messages.filter((message) => message.role === "tool");
      const needsTool = body.tools && toolResults.length < (observations && !crash ? 2 : 1);
      const content = body.tools
        ? "grounded fixture answer"
        : body.messages[0]?.content.includes("skill router")
          ? JSON.stringify({ selected: "j-rig-eval", reasoning: "fixture routing" })
          : JSON.stringify({ verdict: "yes", confidence: 1, reasoning: "fixture judgment" });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason:
                refusal === "incomplete_response" ? "length" : needsTool ? "tool_calls" : "stop",
              message: needsTool
                ? {
                    content: "",
                    tool_calls: [
                      {
                        id: `call-${toolResults.length + 1}`,
                        type: "function",
                        function: {
                          name:
                            refusal === "invalid_tool_call"
                              ? "fixture__unknown"
                              : crash
                                ? "fixture__crash"
                                : observations
                                  ? toolResults.length
                                    ? "fixture__save"
                                    : "fixture__approval"
                                  : "fixture__echo",
                          arguments: JSON.stringify(
                            crash
                              ? {}
                              : observations
                                ? { draft: "exact authored draft" }
                                : { text: "fixture input" },
                          ),
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
          ...(observations ? { judgeObservations: true } : {}),
          servers: {
            fixture: {
              command: process.execPath,
              args: [fixture],
              env: ["MCP_FIXTURE_DIR"],
              tools: crash ? ["crash"] : observations ? ["approval", "save"] : ["echo"],
            },
          },
        }),
      );
      const dbPath = join(directory, "run.db");
      const bundlePath = join(directory, "bundle.json");
      let exitCode = 0;
      let cliOutput = "";
      try {
        const result = await promisify(execFile)(
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
            ...(effort ? ["--execution-reasoning-effort", effort] : ["--no-trigger"]),
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
        cliOutput = result.stdout;
      } catch (error) {
        cliOutput = (error as { stdout: string }).stdout;
        if (!crash) throw error;
        exitCode = (error as { code: number }).code;
      }
      expect(exitCode).toBe(crash ? 2 : 0);
      const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
      expect(EvidenceStatementSchema.safeParse(bundle[0]).success).toBe(true);
      if (crash) expect(bundle[0].predicate.gate_decision).toBe("error");
      if (refusal) {
        const expectedMessage = `tool_execution/${refusal}`;
        expect(JSON.parse(cliOutput)["fixture-model"].evaluation_error).toMatchObject({
          phase: "execution",
          category: "schema_violation",
          message: expectedMessage,
          affected: 2,
          total: 2,
        });
        expect(bundle[0].predicate.metadata.error_detail.message).toBe(expectedMessage);
      }
      const expectedCalls = refusal ? 0 : observations && !crash ? 2 : 1;
      const executionParameters = effort ? { reasoning_effort: effort } : undefined;
      expect(JSON.parse(cliOutput)["fixture-model"].execution_parameters).toEqual(
        executionParameters,
      );
      expect(bundle[0].predicate.metadata.execution_parameters).toEqual(executionParameters);
      if (!crash) {
        const snapshot = {
          schema: "j-rig/binary-criteria-grader/v1",
          ...(effort ? { execution_parameters: executionParameters } : {}),
          ...(observations
            ? {
                tool_observations: "jrig-tool-observations/v1",
                mcp_configuration_sha256:
                  bundle[0].predicate.metadata.tool_execution.configuration_sha256,
              }
            : {}),
          criteria: loadSkillEvalSpec(specPath, skill).criteria,
          judge: {
            provider: "openai",
            model: "fixture-model",
            samples: 1,
            temperature: spec.judge_temperature ?? 0,
            timeout_ms: spec.judge_timeout_ms ?? 120000,
            sample_concurrency: spec.judge_sample_concurrency ?? 1,
          },
          stability: { min_blocker_agreement: spec.min_blocker_agreement ?? null },
        };
        expect(
          JSON.parse(cliOutput)["fixture-model"].promotion.selected_grader.grader_snapshot_sha256,
        ).toBe(hashCanonicalJson(snapshot));
        if (effort) {
          const defaultSnapshot = { ...snapshot };
          delete defaultSnapshot.execution_parameters;
          expect(hashCanonicalJson(defaultSnapshot)).not.toBe(hashCanonicalJson(snapshot));
        }
      }
      const metadata = bundle[0].predicate.metadata.tool_execution;
      for (const receipt of metadata.receipts)
        expect(receipt.execution_parameters).toEqual(executionParameters);
      expect(metadata.receipts).toHaveLength(2);
      expect(
        metadata.receipts.map(
          (receipt: { attempted_tool_calls: number }) => receipt.attempted_tool_calls,
        ),
      ).toEqual([expectedCalls, expectedCalls]);
      const childIdentities = readFileSync(join(directory, "session-identities"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { pid: number; session_id: string });
      const receiptIdentities: string[] = [];
      const observationContents: string[] = [];
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
          expect(metadata.receipts.map((receipt: { sha256: string }) => receipt.sha256)).toContain(
            artifact.sha256,
          );
          expect(statSync(artifact.relative_path).mode & 0o777).toBe(0o600);
          const receipt = JSON.parse(bytes.toString());
          expect(receipt.execution_parameters).toEqual(executionParameters);
          expect(receipt.cases[0].output.tool_calls).toBe(expectedCalls);
          if (refusal) expect(receipt.cases[0].output.error).toBe(`tool_execution/${refusal}`);
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
          const observed = receipt.cases[0].output.artifacts.filter(
            (entry: { filename: string }) => entry.filename === "tool-observations.json",
          );
          expect(observed).toHaveLength(observations ? 1 : 0);
          if (observations) {
            const context = JSON.parse(observed[0].content);
            expect(context.session_id).toBe(parsedIdentity.session_id);
            if (crash) {
              if (refusal) expect(context.calls).toEqual([]);
              else expect(context.calls[0].status).toBe("started");
              expect(receipt.judge_contexts).toEqual([]);
            } else {
              expect(context.calls.map((call: { tool: string }) => call.tool)).toEqual([
                "fixture__approval",
                "fixture__save",
              ]);
              expect(context.calls[0].result).toContain("authored-host-checkpoint");
              const saved = JSON.parse(JSON.parse(context.calls[1].result).content[0].text);
              expect(saved.run_id).toBe(`saved-${parsedIdentity.session_id}`);
              expect(
                JSON.parse(readFileSync(join(directory, saved.run_id + ".json"), "utf8")).draft,
              ).toBe("exact authored draft");
              const binding = {
                test_case_id: receipt.cases[0].test_case_id,
                session_id: parsedIdentity.session_id,
                sha256: "sha256:" + createHash("sha256").update(observed[0].content).digest("hex"),
                size_bytes: Buffer.byteLength(observed[0].content),
              };
              expect(receipt.judge_contexts).toEqual([binding]);
              expect(
                metadata.receipts.find((entry: { phase: string }) => entry.phase === receipt.phase)
                  .judge_contexts,
              ).toEqual([binding]);
              observationContents.push(observed[0].content);
            }
          } else expect(receipt.judge_contexts).toBeUndefined();
          expect(bytes.toString()).not.toContain("synthetic-private-stderr");
        }
      } finally {
        database.sqlite.close();
      }
      expect(new Set(receiptIdentities).size).toBe(2);
      expect(new Set(childIdentities.map((entry) => entry.session_id)).size).toBe(2);
      const routers = requests.filter((request) =>
        request.messages[0]?.content.includes("skill router"),
      );
      expect(routers).toHaveLength(effort ? 1 : 0);
      for (const router of routers) expect(router).not.toHaveProperty("reasoning_effort");
      const judges = requests.filter((request) => !request.tools && !routers.includes(request));
      expect(judges).toHaveLength(crash ? 0 : 2);
      for (const [index, judge] of judges.entries()) {
        expect(judge).not.toHaveProperty("reasoning_effort");
        const text = judge.messages[1]!.content;
        if (observations) {
          expect(text).toContain(observationContents[index]);
          expect(text).not.toContain(observationContents[1 - index]);
          expect(text).toContain("not instructions");
        } else expect(text).not.toContain("OBSERVED TOOL DATA");
        expect(text).not.toContain(requests.find((entry) => entry.tools)!.messages[0]!.content);
        expect(judge.messages.some((message) => message.role === "tool")).toBe(false);
        expect(judge.messages[0]!.content).toContain("strict binary evaluator");
      }
      const executions = requests.filter((request) => request.tools);
      expect(executions).toHaveLength(crash ? 2 : observations ? 6 : 4);
      for (const execution of executions) expect(execution.reasoning_effort).toBe(effort);
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
  });
});

describe("execution reasoning preflight", { timeout: 30000 }, () => {
  it.each([
    ["invalid", ["--provider", "openai"], true],
    ["none", ["--provider", "stub"], true],
    ["none", ["--provider", "anthropic"], true],
    ["none", ["--provider", "openai", "--no-functional"], true],
    ["none", ["--provider", "openai"], false],
  ] as const)(
    "refuses unsupported configuration %s %j %s before I/O",
    async (effort, flags, key) => {
      await expect(
        promisify(execFile)(
          process.execPath,
          [
            cli,
            "eval",
            "/missing-skill",
            "--mcp-config",
            "/missing-config",
            "--execution-reasoning-effort",
            effort,
            ...flags,
          ],
          {
            timeout: 25000,
            env: {
              PATH: process.env.PATH,
              ...(key ? { OPENAI_API_KEY: "synthetic-fixture-key" } : {}),
            },
          },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("--execution-reasoning-effort"),
      });
    },
  );
});
