import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { hashValue, type EvalSet } from "@intentsolutions/refiner-core";

const cli = resolve("packages/cli/dist/index.js");
const skill = resolve("skill");
const exec = promisify(execFile);

describe("retained rollout to reviewed bootstrap (actual CLI)", { timeout: 60000 }, () => {
  it("exports actual outputs and imports harvested/golden sources with immutable provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "jrig-bootstrap-"));
    let failProvider = false;
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      if (failProvider) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "fixture failure" } }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const content = body.includes("verdict")
        ? JSON.stringify({ verdict: "yes", confidence: 1, reasoning: "fixture" })
        : "observed fixture response";
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture port");
    const env = {
      PATH: process.env.PATH,
      OPENAI_API_KEY: "fixture-not-real",
      LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
      LLM_MODEL: "fixture-model",
    };
    const invoke = (args: string[]) =>
      exec(process.execPath, [cli, ...args], { cwd: root, env, timeout: 25000 });
    try {
      await expect(
        invoke(["refine", "bootstrap", skill, "--eval-set-version", "01.0.0"]),
      ).rejects.toMatchObject({ code: 1 });
      const invalidParent = join(root, "invalid-parent.json");
      writeFileSync(invalidParent, "null");
      await expect(
        invoke(["refine", "bootstrap", skill, "--parent-set-file", invalidParent]),
      ).rejects.toMatchObject({ code: 1 });
      const sourcePath = join(root, "rollouts.json");
      await invoke([
        "eval",
        skill,
        "--spec",
        join(skill, "eval.yaml"),
        "--models",
        "fixture-model",
        "--provider",
        "openai",
        "--no-trigger",
        "--db",
        join(root, "run.db"),
        "--rollout-file",
        sourcePath,
        "--json",
      ]);
      const source = JSON.parse(readFileSync(sourcePath, "utf8"));
      expect(source.status).toBe("completed");
      expect(source.runs[0].outcomes[0].output).toBe("observed fixture response");
      expect(statSync(sourcePath).mode & 0o777).toBe(0o600);
      const first = source.runs[0];
      const review = {
        schema: "j-rig/bootstrap-review/v1",
        skillId: source.skillId,
        skillHash: source.skillHash,
        sourceHash: hashValue(source),
        reviewed: true,
        reviewedAt: "2026-01-01T00:00:00Z",
        items: [
          {
            id: `run-${first.runId}:${first.outcomes[0].id}`,
            expectation: "Human-reviewed expectation, not observed output",
          },
        ],
      };
      const reviewPath = join(root, "review.json");
      writeFileSync(reviewPath, JSON.stringify(review));
      const imported = await invoke([
        "refine",
        "bootstrap",
        skill,
        "--harvest-file",
        sourcePath,
        "--review-file",
        reviewPath,
        "--json",
      ]);
      const set = JSON.parse(imported.stdout) as EvalSet;
      expect(set.source).toBe("harvested");
      expect(set.items[0].expectation).toBe(review.items[0].expectation);
      expect(set.items[0].provenance?.sourceHash).toBe(hashValue(source));
      expect(existsSync(join(root, ".j-rig/refiner/store", hashValue(source)))).toBe(true);
      expect(existsSync(join(root, ".j-rig/refiner/store", hashValue(review)))).toBe(true);
      expect(statSync(join(root, ".j-rig/refiner/store", hashValue(source))).mode & 0o777).toBe(
        0o600,
      );
      expect(statSync(join(root, ".j-rig/refiner/store")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, ".j-rig/refiner")).mode & 0o777).toBe(0o700);
      const golden = {
        schema: "j-rig/golden-traces/v1",
        skillId: source.skillId,
        skillHash: source.skillHash,
        items: [{ id: "gold", prompt: "Golden request", output: "Nominated trace" }],
      };
      const goldenPath = join(root, "golden.json");
      writeFileSync(goldenPath, JSON.stringify(golden));
      const goldenReview = {
        ...review,
        sourceHash: hashValue(golden),
        items: [{ id: "gold", expectation: "Reviewed gold" }],
      };
      writeFileSync(reviewPath, JSON.stringify(goldenReview));
      const parentPath = join(root, "parent.json");
      writeFileSync(parentPath, JSON.stringify(set));
      const gold = JSON.parse(
        (
          await invoke([
            "refine",
            "bootstrap",
            skill,
            "--golden-file",
            goldenPath,
            "--review-file",
            reviewPath,
            "--parent-set-file",
            parentPath,
            "--eval-set-version",
            "1.1.0",
            "--json",
          ])
        ).stdout,
      ) as EvalSet;
      expect(gold).toMatchObject({
        source: "golden",
        lineageParent: set.hash,
        lineageId: set.lineageId,
        evalSetVersion: "1.1.0",
      });
      for (const change of [
        { reviewed: false },
        { sourceHash: "wrong" },
        { skillHash: "foreign" },
        { items: [] },
      ]) {
        writeFileSync(reviewPath, JSON.stringify({ ...goldenReview, ...change }));
        await expect(
          invoke([
            "refine",
            "bootstrap",
            skill,
            "--golden-file",
            goldenPath,
            "--review-file",
            reviewPath,
          ]),
        ).rejects.toMatchObject({ code: 1 });
      }
      failProvider = true;
      const failedPath = join(root, "failed.json");
      await expect(
        invoke([
          "eval",
          skill,
          "--spec",
          join(skill, "eval.yaml"),
          "--models",
          "fixture-model",
          "--provider",
          "openai",
          "--no-trigger",
          "--db",
          join(root, "failed.db"),
          "--rollout-file",
          failedPath,
          "--json",
        ]),
      ).rejects.toMatchObject({ code: 2 });
      const failedSource = JSON.parse(readFileSync(failedPath, "utf8"));
      expect(failedSource.status).toBe("incomplete");
      writeFileSync(reviewPath, JSON.stringify({ ...review, sourceHash: hashValue(failedSource) }));
      await expect(
        invoke([
          "refine",
          "bootstrap",
          skill,
          "--harvest-file",
          failedPath,
          "--review-file",
          reviewPath,
        ]),
      ).rejects.toMatchObject({ code: 1 });
      writeFileSync(goldenPath, "not JSON");
      await expect(
        invoke([
          "refine",
          "bootstrap",
          skill,
          "--golden-file",
          goldenPath,
          "--review-file",
          reviewPath,
        ]),
      ).rejects.toMatchObject({ code: 1 });

      source.runs[0].status = "failed";
      const invalidSourcePath = join(root, "invalid-source.json");
      writeFileSync(invalidSourcePath, JSON.stringify(source), { flag: "wx", mode: 0o600 });
      writeFileSync(reviewPath, JSON.stringify({ ...review, sourceHash: hashValue(source) }));
      await expect(
        invoke([
          "refine",
          "bootstrap",
          skill,
          "--harvest-file",
          invalidSourcePath,
          "--review-file",
          reviewPath,
        ]),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
