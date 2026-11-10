import { it, expect } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrapFromItems, makeSkillDoc, type CostPolicy } from "@intentsolutions/refiner-core";
import { RefinerStore } from "./store.js";
import { type CostOutcomeReport } from "./cost-context.js";
const exec = promisify(execFile);
const cli = resolve("packages/cli/dist/index.js");
it.each([
  "score",
  "deny-judge",
  "propose-parse-failure",
  "propose-overrun",
  "propose-success",
  "assess-accepted",
  "assess-rejected",
  "assess-blocked",
])(
  "actual Refiner CLI cost outcome and telemetry: %s",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "refiner-cost-cli-"));
    let calls = 0;
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const judge = !mode.startsWith("propose") && body.includes("verdict");
      const assessment = mode.startsWith("assess");
      const index = Number(body.match(/Expected (\d+)/)?.[1] ?? 0);
      const improved = body.includes("improved");
      const pass =
        !assessment ||
        (index < 10 ? index < 5 : (improved && mode === "assess-accepted") || index < 15);
      calls++;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          model: "actual-fixture",
          usage: { prompt_tokens: mode === "propose-overrun" ? 100001 : 3, completion_tokens: 2 },
          choices: [
            {
              finish_reason: "stop",
              message: {
                content:
                  mode === "propose-success"
                    ? JSON.stringify({
                        rationale: "Fixture",
                        ops: [
                          {
                            kind: "replace",
                            target: "Return the number",
                            content: "Precisely return the number",
                          },
                        ],
                      })
                    : judge
                      ? JSON.stringify({
                          verdict: pass ? "yes" : "no",
                          confidence: 1,
                          reasoning: "fixture",
                        })
                      : assessment
                        ? body.includes("Precisely")
                          ? "improved"
                          : "baseline"
                        : "7",
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const skill = join(root, "demo");
      mkdirSync(skill);
      const doc = makeSkillDoc(
        "demo",
        "---\nname: demo\ndescription: Return a requested number.\nallowed-tools: [Read]\nversion: 1.0.0\nauthor: Synthetic Fixture\nlicense: MIT\ncompatibility: Node.js 20+\ntags: [testing]\n---\n\nReturn the number requested by the user.\n",
      );
      writeFileSync(join(skill, "SKILL.md"), doc.text);
      writeFileSync(
        join(root, "eval.json"),
        JSON.stringify(
          bootstrapFromItems(doc, "synthetic", [
            { id: "number", prompt: "Return 7", expectation: "The answer is 7" },
          ]),
        ),
      );
      const policy: CostPolicy = {
        schema: "refiner-cost-policy/v1",
        scopeId: "fixture",
        profile: "custom",
        source: "synthetic test rates",
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
        maxFileMicros: mode === "deny-judge" ? 100001 : 1000000,
        maxTotalMicros: 2000000,
        meanFileBudgetMicros: 1000000,
        stopBasisPoints: 8000,
      };
      writeFileSync(join(root, "policy.json"), JSON.stringify(policy));
      const bin = join(root, "bin");
      mkdirSync(bin);
      symlinkSync(cli, join(bin, "j-rig"));
      const assessing = mode.startsWith("assess");
      let proposal: string | undefined;
      if (assessing) {
        const items = Array.from({ length: 40 }, (_, i) => ({
          id: `case-${i}`,
          prompt: `Request ${i}`,
          expectation: `Expected ${i}`,
          adversarial: i < 10,
        }));
        const evalSet = bootstrapFromItems(doc, "synthetic", items, {
          now: new Date().toISOString(),
        });
        writeFileSync(join(root, "eval.json"), JSON.stringify(evalSet));
        proposal = new RefinerStore({ root }).putEditProposal({
          parent: doc.hash,
          ops: [
            {
              kind: "replace",
              target: "Return the number",
              content: "Precisely return the number",
            },
          ],
          refinerModel: "fixture",
          refinerStrategyId: "test",
          rationale: "Fixture improvement",
        });
        writeFileSync(
          join(root, "quality.json"),
          JSON.stringify({
            evidence:
              mode === "assess-blocked"
                ? undefined
                : {
                    evalSetHash: evalSet.hash,
                    verifiedEvalSet: true,
                    reviewedAt: new Date(Date.now() - 3600000).toISOString(),
                    expiresAt: new Date(Date.now() + 86400000).toISOString(),
                    judge: { provider: "openai", model: "actual-fixture" },
                    referenceItems: [{ id: "ref", prompt: "Training reference" }],
                    predictions: Array.from({ length: 10 }, () => ({
                      confidence: 1,
                      correct: true,
                    })),
                    manifest: {
                      skillId: "demo",
                      evalSetHash: evalSet.hash,
                      capabilities: [{ id: "task", minimumItems: 40 }],
                      assignments: items.map((item) => ({
                        itemId: item.id,
                        capabilityIds: ["task"],
                      })),
                    },
                  },
            policy: {
              maxLeakage: 0,
              maxDuplicateRatio: 0,
              maxBrierScore: 0.1,
              maxEce: 0.1,
              minCalibrationSamples: 10,
              minAdversarialItems: 10,
            },
          }),
        );
        policy.maxFileMicros = 100000000;
        policy.maxTotalMicros = 200000000;
        policy.rates.push({ ...policy.rates[0]!, model: "actual-fixture" });
        writeFileSync(join(root, "policy.json"), JSON.stringify(policy));
      }
      const args = [
        cli,
        "refine",
        mode.startsWith("propose") ? "propose" : assessing ? "assess" : "score",
        skill,
        "--provider",
        "openai",
        "--model",
        "fixture",
        "--cost-policy",
        join(root, "policy.json"),
        "--cost-file-id",
        "demo",
        "--json",
      ];
      if (!mode.startsWith("propose")) args.push("--eval-set-file", join(root, "eval.json"));
      if (assessing)
        args.push("--proposal", proposal!, "--quality-file", join(root, "quality.json"));
      const result = await exec(process.execPath, args, {
        cwd: root,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          OPENAI_API_KEY: "synthetic-fixture-key",
          LLM_MODEL: "fixture",
          LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
          J_RIG_OTEL: "1",
        },
      }).then(
        (value) => ({ ...value, code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error,
      );
      expect(result.code, result.stderr + result.stdout.slice(0, 2000)).toBe(
        mode === "score" || mode === "assess-accepted" || mode === "propose-success"
          ? 0
          : assessing
            ? 2
            : 1,
      );
      const expectedCalls =
        mode === "assess-blocked" ? 0 : assessing ? 160 : mode === "score" ? 2 : 1;
      expect(calls, result.stdout).toBe(expectedCalls);
      const store = new RefinerStore({ root });
      const events = store
        .readLog()
        .filter((event) => event.type === "stored" && event.kind === "cost-outcome");
      expect(events).toHaveLength(1);
      const event = events[0]!;
      if (event.type !== "stored") throw new Error("Missing cost outcome");
      const report = store.get<CostOutcomeReport>(event.hash)!;
      expect(report).toMatchObject({
        decision:
          mode === "propose-success"
            ? "proposed"
            : mode === "score"
              ? "scored"
              : mode === "assess-accepted"
                ? "accepted"
                : mode === "assess-rejected"
                  ? "rejected"
                  : mode === "assess-blocked"
                    ? "blocked"
                    : "failed",
        knownMicros: mode === "propose-overrun" ? 100001 : expectedCalls * 3,
        unknownCalls: 0,
      });
      expect(report.file.quarantined).toBe(mode === "deny-judge" || mode === "propose-overrun");
      expect(report.p0).toBe(mode === "propose-overrun");
      expect(
        store
          .readLog()
          .filter((event) => event.type === "stored" && event.kind === "cost-quarantine"),
      ).toHaveLength(report.file.quarantined ? 1 : 0);
      expect(
        store
          .readLog()
          .filter((event) => event.type === "stored" && event.kind === "cost-governance-finding"),
      ).toHaveLength(report.p0 ? 1 : 0);
      expect(report.file.costPerAcceptMicros).toBe(mode === "assess-accepted" ? 480 : null);
      const telemetry = result.stderr
        .split("\n")
        .filter((line) => line.startsWith("[OTEL] "))
        .map(
          (line) =>
            JSON.parse(line.slice(7)) as { name: string; attributes: Record<string, unknown> },
        );
      const recorded = telemetry.find(
        (event) =>
          event.name === "cost.run.recorded" &&
          event.attributes["cost.record.scope"] === "refiner-attempt",
      );
      expect(recorded?.attributes).toMatchObject({
        "refiner.attempt_id": report.attemptId,
        "refiner.file_id": "demo",
        "refiner.policy_hash": report.policyHash,
        "cost.outcome": report.decision,
        "cost.run.estimated_usd": report.knownMicros / 1000000,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
