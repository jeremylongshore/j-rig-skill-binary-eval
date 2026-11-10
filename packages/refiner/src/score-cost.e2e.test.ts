import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  bootstrapFromItems,
  makeSkillDoc,
  type EvaluationUsageEvidence,
} from "@intentsolutions/refiner-core";
import { createAccountingEvalRunner } from "./score-evidence.js";
import { createSubprocessEvalRunner, scoreWithEvidence } from "./score.js";
import { RefinerStore } from "./store.js";

describe("actual evaluator cost to Refiner receipt", { timeout: 30000 }, () => {
  it.each([false, true])(
    "retains provider usage across the subprocess boundary (judge fails=%s)",
    async (failJudge) => {
      const root = mkdtempSync(join(tmpdir(), "refiner-eval-cost-"));
      let calls = 0;
      const server = createServer(async (request, response) => {
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
        const doc = makeSkillDoc(
          "demo",
          "---\nname: demo\ndescription: Return the requested number.\n---\n\nReturn the number requested by the user.\n",
        );
        const evalSet = bootstrapFromItems(doc, "synthetic", [
          { id: "number", prompt: "Return 7", expectation: "The answer is 7" },
        ]);
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
            },
          }),
          store,
        );
        const action = scoreWithEvidence(doc, evalSet, runner, {
          skillDir: root,
          provider: "openai",
          modelTier: "fixture",
        });
        if (failJudge) await expect(action).rejects.toThrow("provider infrastructure failure");
        else {
          const result = await action;
          expect(result.record.behavioral.value).toBe(1);
          expect(result.usage.status).toBe("reported");
          expect(result.usage.evidence?.calls).toHaveLength(2);
        }
        expect(calls).toBe(2);
        const receiptEvent = store.readLog().at(-1)!;
        if (receiptEvent.type !== "stored") throw new Error("missing receipt");
        const receipt = store.get<{ status: string; usage: { evidence: EvaluationUsageEvidence } }>(
          receiptEvent.hash,
        )!;
        expect(receipt.status).toBe(failJudge ? "failed" : "completed");
        const records = receipt.usage.evidence.calls;
        expect(records[0]).toMatchObject({
          phase: "execution",
          requestedModel: "fixture",
          reportedModel: "actual-fixture",
          usage: { inputTokens: 3, outputTokens: 2 },
        });
        expect(records[1]).toMatchObject(
          failJudge
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
