import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  bootstrapFromItems,
  makeSkillDoc,
  type EvaluationUsageEvidence,
  type CostPolicy,
} from "@intentsolutions/refiner-core";
import { createAccountingEvalRunner } from "./score-evidence.js";
import { createSubprocessEvalRunner, scoreWithEvidence } from "./score.js";
import { openCostSession } from "./cost-context.js";
import { RefinerStore } from "./store.js";

describe("actual evaluator cost to Refiner receipt", { timeout: 30000 }, () => {
  it.each([
    { failJudge: false, governed: false, denyJudge: false },
    { failJudge: true, governed: false, denyJudge: false },
    { failJudge: false, governed: true, denyJudge: false },
    { failJudge: true, governed: true, denyJudge: false },
    { failJudge: false, governed: true, denyJudge: true },
  ])(
    "retains subprocess usage and enforces shared admission: %j",
    async ({ failJudge, governed, denyJudge }) => {
      const root = mkdtempSync(join(tmpdir(), "refiner-eval-cost-"));
      let calls = 0;
      const server = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const prompt = Buffer.concat(chunks).toString().toLowerCase();
        const judge = prompt.includes("verdict");
        calls++;
        if (judge && failJudge) {
          response.writeHead(500).end('{"error":{"message":"private fixture error"}}');
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            model: "actual-fixture",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: judge
                    ? JSON.stringify({ verdict: "yes", confidence: 1, reasoning: "fixture" })
                    : "7",
                },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        );
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no fixture port");
      try {
        // Health/port probes must not be counted as model completions.
        expect((await fetch(`http://127.0.0.1:${address.port}/`)).status).toBe(404);
        expect(calls).toBe(0);
        const doc = makeSkillDoc(
          "demo",
          "---\nname: demo\ndescription: Return the requested number.\n---\n\nReturn the number requested by the user.\n",
        );
        const evalSet = bootstrapFromItems(doc, "synthetic", [
          { id: "number", prompt: "Return 7", expectation: "The answer is 7" },
        ]);
        const policy: CostPolicy = {
          schema: "refiner-cost-policy/v1",
          scopeId: "fixture",
          profile: "custom",
          source: "synthetic fixture",
          files: ["demo"],
          rates: [
            {
              provider: "openai",
              model: "fixture",
              reportedModels: ["actual-fixture"],
              format: "openai",
              maxInputTokens: 100000,
              maxOutputTokens: 10000,
              protocolOverheadTokens: 100,
              microsPerMillionTokens: {
                input: 1000000,
                output: 0,
                cacheRead: 1000000,
                cacheWrite: 1000000,
                cacheWrite5m: 1000000,
                cacheWrite1h: 1000000,
              },
            },
          ],
          maxFileMicros: denyJudge ? 100001 : 1000000,
          maxTotalMicros: 2000000,
          meanFileBudgetMicros: 1000000,
          stopBasisPoints: 8000,
        };
        const context = {
          policyPath: join(root, "policy.json"),
          ledgerPath: join(root, "audit", "wave-b-cost-ledger.jsonl"),
          fileId: "demo",
          attemptId: "paired-assessment",
        };
        writeFileSync(context.policyPath, JSON.stringify(policy));
        const session = governed ? openCostSession(context) : undefined;
        const store = new RefinerStore({ root });
        const runner = createAccountingEvalRunner(
          createSubprocessEvalRunner({
            command: process.execPath,
            args: [resolve("packages/cli/dist/index.js"), "eval"],
            env: {
              PATH: process.env.PATH,
              OPENAI_API_KEY: "synthetic-fixture-key",
              LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
              LLM_MODEL: "fixture",
              JRIG_COST_CONTEXT: "ambient-invalid-context-must-not-leak",
            },
          }),
          store,
        );
        const action = scoreWithEvidence(doc, evalSet, runner, {
          skillDir: root,
          provider: "openai",
          modelTier: "fixture",
          ...(session ? { costContext: session.context } : {}),
        });
        if (denyJudge) await expect(action).rejects.toThrow("evaluation budget exhausted");
        else if (failJudge) await expect(action).rejects.toThrow("provider infrastructure failure");
        else {
          const result = await action;
          expect(result.record.behavioral.value).toBe(1);
          expect(result.usage.status).toBe("reported");
          expect(result.usage.evidence?.calls).toHaveLength(2);
        }
        expect(calls).toBe(denyJudge ? 1 : 2);
        if (session) {
          const state = session.ledger.snapshot();
          expect(state.calls.size).toBe(denyJudge ? 1 : 2);
          expect(state.total.knownMicros).toBe(failJudge || denyJudge ? 3 : 6);
          expect(state.total.unknownCalls).toBe(failJudge ? 1 : 0);
          expect([...state.calls.values()].map((c) => c.reservation.phase)).toEqual(
            denyJudge ? ["execution"] : ["execution", "judge"],
          );
          expect(state.files.demo?.quarantined).toBe(failJudge || denyJudge);
        }
        const receiptEvent = store.readLog().at(-1)!;
        if (receiptEvent.type !== "stored") throw new Error("missing receipt");
        const receipt = store.get<{ status: string; usage: { evidence: EvaluationUsageEvidence } }>(
          receiptEvent.hash,
        )!;
        expect(receipt.status).toBe(failJudge || denyJudge ? "failed" : "completed");
        const records = receipt.usage.evidence.calls;
        expect(records[0]).toMatchObject({
          phase: "execution",
          requestedModel: "fixture",
          reportedModel: "actual-fixture",
          usage: { inputTokens: 3, outputTokens: 2 },
        });
        expect(records[1]).toMatchObject(
          failJudge || denyJudge
            ? { phase: "judge", outcome: "failed", usage: null }
            : { phase: "judge", outcome: "completed", usage: { inputTokens: 3, outputTokens: 2 } },
        );
        expect(JSON.stringify(receipt)).not.toContain("private fixture error");
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
