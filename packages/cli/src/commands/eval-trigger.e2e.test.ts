import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createDatabase } from "@j-rig/db";
import { EvidenceStatementSchema, computeMetrics } from "@j-rig/core";
import { parse, stringify } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../../dist/index.js");
const skill = join(here, "../../../../skill");

describe("actual CLI trigger evidence", { timeout: 30000 }, () => {
  it.each([
    "correct",
    "incorrect",
    "provider-error",
    "skipped",
    "not-applicable",
    "trigger-only-error",
  ])("retains independently verifiable routing (%s)", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "jrig-trigger-"));
    let triggerCalls = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const trigger = body.messages[0].content.includes("skill router");
      expect(body.tools).toBeUndefined();
      if (trigger) triggerCalls++;
      if (trigger && mode.includes("error")) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "synthetic authorization failure" } }));
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: trigger
                  ? JSON.stringify({
                      selected: mode === "incorrect" ? null : "j-rig-eval",
                      reasoning: "private routing rationale",
                    })
                  : "fixture functional answer",
              },
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
      spec.criteria = [spec.criteria[0]];
      spec.test_cases[0].criteria_ids = [spec.criteria[0].id];
      if (mode === "not-applicable") delete spec.test_cases[0].trigger_expectation;
      const specPath = join(directory, "eval.yaml");
      writeFileSync(specPath, stringify(spec));
      const dbPath = join(directory, "run.db");
      const bundlePath = join(directory, "bundle.json");
      let exitCode = 0;
      let stdout = "";
      try {
        ({ stdout } = await promisify(execFile)(
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
            ...(mode === "skipped" ? ["--no-trigger"] : []),
            ...(mode === "trigger-only-error" ? ["--no-functional"] : []),
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
            },
          },
        ));
      } catch (error) {
        const failed = error as { code: number; stdout: string };
        exitCode = failed.code;
        stdout = failed.stdout;
      }
      expect(exitCode).toBe(mode.includes("error") ? 2 : 0);
      const result = JSON.parse(stdout)["fixture-model"];
      const status =
        mode === "skipped"
          ? "skipped"
          : mode === "not-applicable"
            ? "not_applicable"
            : mode.includes("error")
              ? "incomplete"
              : "complete";
      expect(result.trigger.status).toBe(status);
      expect(triggerCalls).toBe(["skipped", "not-applicable"].includes(mode) ? 0 : 1);
      const database = createDatabase(dbPath);
      try {
        const artifacts = database.sqlite
          .prepare("SELECT * FROM artifacts WHERE artifact_type = 'trigger-evidence'")
          .all() as { relative_path: string; sha256: string }[];
        expect(artifacts).toHaveLength(1);
        const artifact = artifacts[0]!;
        const bytes = readFileSync(artifact.relative_path);
        expect(artifact.sha256).toBe("sha256:" + createHash("sha256").update(bytes).digest("hex"));
        expect(result.trigger.sha256).toBe(artifact.sha256);
        expect(statSync(artifact.relative_path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(artifact.relative_path)).mode & 0o777).toBe(0o700);
        const privateReceipt = JSON.parse(bytes.toString());
        expect(privateReceipt.status).toBe(status);
        expect(result.trigger.metrics).toEqual(computeMetrics(privateReceipt.results));
        expect(result.trigger.cases).toEqual(
          privateReceipt.results.map(
            ({ test_case_id, expected, outcome, selected_skill }: Record<string, unknown>) => ({
              test_case_id,
              expected,
              outcome,
              selected_skill,
            }),
          ),
        );
        expect(JSON.stringify(result.trigger)).not.toContain("private routing rationale");
        if (triggerCalls)
          expect(result.trigger.cases[0].outcome).toBe(
            mode.includes("error")
              ? "error"
              : mode === "incorrect"
                ? "false_negative"
                : "correct_trigger",
          );
        if (mode.includes("error")) {
          expect(result.gate_decision).toBe("error");
          expect(result.evaluation_error.phase).toBe("trigger");
          expect(result.evaluation_error.category).toBe("authentication");
          expect(result.evaluation_error.affected).toBe(1);
          expect(result.promotion).toBeUndefined();
          const run = database.sqlite.prepare("SELECT status FROM runs").get() as {
            status: string;
          };
          expect(run.status).toBe("failed");
        }
      } finally {
        database.sqlite.close();
      }
      if (mode !== "trigger-only-error") {
        const row = JSON.parse(readFileSync(bundlePath, "utf8"))[0];
        expect(EvidenceStatementSchema.safeParse(row).success).toBe(true);
        expect(row.predicate.metadata.trigger).toEqual(result.trigger);
        expect(row.predicate.coverage.dimensions_evaluated.includes("trigger")).toBe(
          status === "complete",
        );
        if (mode.includes("error")) {
          expect(row.predicate.gate_decision).toBe("error");
          expect(row.predicate.metadata.promotion_eligible).toBeUndefined();
          expect(row.predicate.gate_reasons[0]).toContain("provider_failure/trigger");
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
