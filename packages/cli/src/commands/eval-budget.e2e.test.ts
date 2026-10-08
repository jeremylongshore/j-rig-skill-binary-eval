import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@j-rig/db";
import { parse, stringify } from "yaml";

// Budget stops through the real CLI against a local OpenAI-compatible fixture
// endpoint (no model spend): the run stops cleanly, records why, writes no
// verdict, and exits 3.

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../../dist/index.js");
const skill = join(here, "../../../../skill");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function fixtureServer(): Promise<{ server: Server; port: number; calls: () => number }> {
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    const prompt = JSON.stringify(body.messages);
    const content = prompt.includes("skill router")
      ? JSON.stringify({ selected: "j-rig-eval", reasoning: "fixture" })
      : prompt.includes("VERDICT") || prompt.includes("verdict")
        ? JSON.stringify({ verdict: "yes", confidence: 1, reasoning: "fixture judge" })
        : "fixture functional answer: SHIP";
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  return { server, port: address.port, calls: () => calls };
}

async function runEval(
  port: number,
  specMutate: (spec: Record<string, unknown>) => void,
  flags: string[],
  models = "fixture-model",
) {
  const directory = mkdtempSync(join(tmpdir(), "jrig-budget-"));
  dirs.push(directory);
  const spec = parse(readFileSync(join(skill, "eval.yaml"), "utf8")) as Record<string, unknown>;
  specMutate(spec);
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
        models,
        "--db",
        dbPath,
        "--emit-bundle",
        bundlePath,
        "--json",
        ...flags,
      ],
      {
        timeout: 25000,
        env: {
          PATH: process.env.PATH,
          OPENAI_API_KEY: "synthetic-fixture-key",
          LLM_BASE_URL: `http://127.0.0.1:${port}`,
          LLM_MODEL: "fixture-model",
        },
      },
    ));
  } catch (error) {
    const failed = error as { code: number; stdout: string };
    exitCode = failed.code;
    stdout = failed.stdout;
  }
  return {
    exitCode,
    out: JSON.parse(stdout) as Record<string, Record<string, unknown>>,
    dbPath,
    bundlePath,
  };
}

describe("j-rig eval budgets (actual CLI)", { timeout: 30000 }, () => {
  it("stops on --max-calls with no verdict, records why, skips later models, exits 3", async () => {
    const { server, port, calls } = await fixtureServer();
    try {
      const r = await runEval(port, () => {}, ["--max-calls", "2"], "fixture-model,second-model");
      expect(r.exitCode).toBe(3);
      // The guard refused every call past the limit.
      expect(calls()).toBe(2);
      const first = r.out["fixture-model"]!;
      expect(first.budget_stop).toMatchObject({
        limit: "max_calls",
        max: 2,
        observed: 2,
        source: "run",
        model: "fixture-model",
      });
      expect(first).not.toHaveProperty("decision");
      expect(first).not.toHaveProperty("promotion");
      expect(first).not.toHaveProperty("gate_decision");
      expect(r.out["second-model"]).toMatchObject({ skipped: "budget_exhausted" });
      expect(first.run_budget).toMatchObject({ limits: { max_calls: 2 }, spent: { calls: 2 } });
      // No verdict means no Evidence Bundle row.
      expect(existsSync(r.bundlePath)).toBe(false);
      const database = createDatabase(r.dbPath);
      try {
        const runs = database.sqlite.prepare("SELECT status, error_message FROM runs").all() as {
          status: string;
          error_message: string;
        }[];
        expect(runs).toHaveLength(1);
        expect(runs[0]!.status).toBe("failed");
        expect(JSON.parse(runs[0]!.error_message)).toMatchObject({
          type: "budget_exhausted",
          limit: "max_calls",
        });
      } finally {
        database.close();
      }
    } finally {
      server.close();
    }
  });

  it("honors a spec budget and lets a flag tighten but not loosen it", async () => {
    const { server, port, calls } = await fixtureServer();
    try {
      // Every fixture call reports 3 + 2 = 5 tokens.
      const r = await runEval(port, (spec) => (spec.budget = { max_tokens: 5 }), [
        "--max-tokens",
        "500",
      ]);
      expect(r.exitCode).toBe(3);
      expect(calls()).toBe(1);
      expect(r.out["fixture-model"]!.budget_stop).toMatchObject({
        limit: "max_tokens",
        max: 5,
        observed: 5,
        source: "spec",
      });
    } finally {
      server.close();
    }
  });

  it("fails --max-usd closed when the model has no rate on file", async () => {
    const { server, port, calls } = await fixtureServer();
    try {
      const r = await runEval(port, () => {}, ["--max-usd", "5"]);
      expect(r.exitCode).toBe(3);
      expect(calls()).toBe(1);
      const stop = r.out["fixture-model"]!.budget_stop as { observed: unknown; reason: string };
      expect(stop.observed).toBeNull();
      expect(stop.reason).toMatch(/fixture-model has no rate on file/);
    } finally {
      server.close();
    }
  });

  it("completes normally within budget and reports what it spent", async () => {
    const { server, port, calls } = await fixtureServer();
    try {
      const r = await runEval(
        port,
        (spec) => {
          spec.test_cases = (spec.test_cases as unknown[]).slice(0, 1);
        },
        ["--max-calls", "1000", "--max-wall-ms", "600000"],
      );
      expect(r.exitCode).toBe(0);
      const row = r.out["fixture-model"]!;
      expect(row).not.toHaveProperty("budget_stop");
      expect(row.run_budget).toMatchObject({ stop: null, spent: { calls: calls() } });
      expect(existsSync(r.bundlePath)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("rejects a malformed budget flag before any call", async () => {
    const { server, port, calls } = await fixtureServer();
    try {
      await expect(runEval(port, () => {}, ["--max-calls", "2.5"])).rejects.toThrow();
      expect(calls()).toBe(0);
    } finally {
      server.close();
    }
  });
});
