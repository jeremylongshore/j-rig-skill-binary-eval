import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CostPolicy } from "@intentsolutions/refiner-core";
import type { Transport } from "../providers/transport.js";
import { replayDigest } from "./judge-replay-input.js";
import { readReplayDocument, replayReadFlags, runJudgeReplay } from "./judge-replay.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "judge-replay-"));
  roots.push(root);
  const save = (name: string, value: unknown) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const corpusValue = {
    schema: "j-rig/judge-replay-corpus/v1",
    source: { revision: "synthetic", artifact_sha256: `sha256:${"0".repeat(64)}` },
    rows: [
      {
        id: "row",
        criterion: { id: "criterion", description: "Says hello" },
        prompt: "Greet",
        output: "hello",
      },
    ],
  };
  const corpus = save("corpus.json", corpusValue);
  const review = save("review.json", {
    schema: "j-rig/judge-replay-review/v1",
    corpus_sha256: replayDigest(JSON.stringify(corpusValue)),
    reviewer: "synthetic-test-reviewer",
    reviewed_at: "2026-01-01T00:00:00Z",
    reviewed: true,
    labels: [{ id: "row", expected_verdict: "yes", rationale: "Synthetic fixture" }],
  });
  const policy = save("policy.json", {
    provider: "groq",
    model: "offline",
    samples: 1,
    repeats: 1,
    temperature: 0,
    requests_per_minute: 60_000,
    judge_timeout_ms: 1000,
    max_wall_ms: 5000,
    max_calls: 1,
  });
  const cost: CostPolicy = {
    schema: "refiner-cost-policy/v1",
    scopeId: "synthetic",
    profile: "custom",
    source: "synthetic-test-rate-not-a-provider-price",
    files: ["cell"],
    rates: [
      {
        provider: "groq",
        model: "offline",
        reportedModels: ["offline"],
        format: "openai",
        maxInputTokens: 10000,
        maxOutputTokens: 2048,
        protocolOverheadTokens: 0,
        microsPerMillionTokens: {
          input: 1000000,
          output: 1000000,
          cacheRead: 1000000,
          cacheWrite: 1000000,
          cacheWrite5m: 1000000,
          cacheWrite1h: 1000000,
        },
      },
    ],
    maxFileMicros: 20000,
    maxTotalMicros: 20000,
    meanFileBudgetMicros: 20000,
    stopBasisPoints: 10000,
    maxFileTokens: 20000,
    maxFileAttempts: 1,
  };
  const options = {
    corpus,
    review,
    policy,
    output: join(root, "output"),
    costPolicy: save("cost.json", cost),
    costLedger: join(root, "ledger.jsonl"),
    costFileId: "cell",
  };
  const transport = vi.fn<Transport>(async () => ({
    status: 200,
    json: {
      model: "offline",
      choices: [
        {
          message: { content: '{"verdict":"yes","confidence":1,"reasoning":"offline"}' },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    },
  }));
  return {
    root,
    cost,
    options,
    transport,
    env: { GROQ_API_KEY: "synthetic-test-only", LLM_BASE_URL: "https://offline.invalid/v1" },
  };
}

describe("private replay command boundary", () => {
  it.each([undefined, 0])(
    "refuses unavailable no-follow/nonblocking flags before opening",
    (flag) => {
      expect(() => replayReadFlags({ O_RDONLY: 0, O_NOFOLLOW: flag, O_NONBLOCK: 2048 })).toThrow(
        "supported",
      );
      expect(() => replayReadFlags({ O_RDONLY: 0, O_NOFOLLOW: 131072, O_NONBLOCK: flag })).toThrow(
        "supported",
      );
    },
  );

  it.each(["configuration", "policy"])(
    "retains terminal %s refusal after publishing an execution plan",
    async (kind) => {
      const f = setup();
      if (kind === "policy") writeFileSync(f.options.costPolicy, "{}");
      await expect(
        runJudgeReplay(
          { ...f.options, execute: true },
          { ...f, env: kind === "configuration" ? {} : f.env },
        ),
      ).rejects.toThrow();
      expect(f.transport).not.toHaveBeenCalled();
      expect(existsSync(join(f.options.output, "report.json"))).toBe(false);
      const failure = JSON.parse(readFileSync(join(f.options.output, "failure.json"), "utf8"));
      expect(failure).toMatchObject({
        status: "failed",
        execution_requested: true,
        wire_calls: 0,
        stage: kind === "configuration" ? "provider-configuration" : "cost-session-admission",
      });
      const plan = JSON.parse(readFileSync(join(f.options.output, "plan.json"), "utf8"));
      expect(plan).toMatchObject({ status: "planned", executed: false, execution_requested: true });
    },
  );

  it("plans without credentials, transport or a cost ledger", async () => {
    const f = setup();
    const result = await runJudgeReplay(f.options, { env: {}, transport: f.transport });
    expect(result.status).toBe("planned");
    expect(f.transport).not.toHaveBeenCalled();
    expect(existsSync(f.options.costLedger)).toBe(false);
    expect(JSON.parse(readFileSync(join(f.options.output, "plan.json"), "utf8")).executed).toBe(
      false,
    );
  });

  it("uses actual provider normalization, governed ledger and private report publication", async () => {
    const f = setup();
    const result = await runJudgeReplay({ ...f.options, execute: true }, f);
    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(f.transport).toHaveBeenCalledTimes(1);
    const path = join(f.options.output, "report.json");
    const bytes = readFileSync(path, "utf8");
    const report = JSON.parse(bytes);
    expect(report).toMatchObject({
      accuracy: 1,
      wire_calls: 1,
      identity: { provider: "groq", model: "offline" },
      cost: { calls: 1, unknownCalls: 0, inputTokens: 20, outputTokens: 10 },
    });
    expect(bytes).not.toContain(f.env.GROQ_API_KEY);
    expect(bytes).not.toContain("offline.invalid");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(f.options.output).mode & 0o777).toBe(0o700);
  });

  it("refuses mismatched review before any output or provider activity", async () => {
    const f = setup();
    writeFileSync(f.options.corpus, readFileSync(f.options.corpus, "utf8") + "\n");
    await expect(runJudgeReplay({ ...f.options, execute: true }, f)).rejects.toThrow("bind corpus");
    expect(f.transport).not.toHaveBeenCalled();
    expect(existsSync(f.options.output)).toBe(false);
  });

  it("retains an incomplete report when the reservation cap refuses a call", async () => {
    const f = setup();
    writeFileSync(f.options.costPolicy, JSON.stringify({ ...f.cost, maxFileAttempts: 0 }));
    const result = await runJudgeReplay({ ...f.options, execute: true }, f);
    expect(result.exitCode).toBe(2);
    expect(f.transport).not.toHaveBeenCalled();
    const report = JSON.parse(readFileSync(join(f.options.output, "report.json"), "utf8"));
    expect(report).toMatchObject({
      status: "incomplete",
      completed_cells: 0,
      accuracy: 0,
      wire_calls: 0,
      provider_invocations: 1,
      failed_samples: 0,
      admission_refused_samples: 1,
    });
  });

  it("retains the sealed scored outcome when report publication fails", async () => {
    const f = setup();
    const transport: Transport = async (request) => {
      mkdirSync(join(f.options.output, "report.json"));
      return f.transport(request);
    };
    await expect(
      runJudgeReplay({ ...f.options, execute: true }, { ...f, transport }),
    ).rejects.toThrow();
    const failure = JSON.parse(readFileSync(join(f.options.output, "failure.json"), "utf8"));
    expect(failure).toMatchObject({
      status: "failed",
      stage: "report-publication",
      wire_calls: 1,
      cost_outcome: "scored",
    });
    const outcomes = readFileSync(f.options.costLedger, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event)
      .filter((event) => event.kind === "outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].decision).toBe("scored");
    expect(statSync(join(f.options.output, "report.json")).isDirectory()).toBe(true);
  });

  it("honors an already cancelled execution without a transport call", async () => {
    const f = setup();
    const result = await runJudgeReplay(
      { ...f.options, execute: true },
      { ...f, signal: AbortSignal.abort() },
    );
    expect(result.exitCode).toBe(2);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("rejects BOM and malformed UTF-8 without reencoding their identities", () => {
    const f = setup();
    const bytes = readFileSync(f.options.corpus);
    writeFileSync(f.options.corpus, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
    expect(() => readReplayDocument(f.options.corpus)).toThrow("BOM");
    writeFileSync(f.options.corpus, Buffer.from([0xc3, 0x28]));
    expect(() => readReplayDocument(f.options.corpus)).toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("never overwrites existing output and rejects symlink/nonregular input", async () => {
    const f = setup();
    await runJudgeReplay(f.options, f);
    await expect(runJudgeReplay(f.options, f)).rejects.toThrow();
    const link = join(f.root, "link.json");
    symlinkSync(f.options.corpus, link);
    expect(() => readReplayDocument(link)).toThrow();
    expect(() => readReplayDocument(f.root)).toThrow();
  });
});
