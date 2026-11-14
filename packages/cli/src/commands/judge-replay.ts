import type { Command } from "commander";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openCostSession, recordCostOutcome, type CostSession } from "@intentsolutions/refiner";
import {
  resolveOpenAICompatConfig,
  type OpenAICompatConfig,
} from "../providers/openai-compatible.js";
import type { Transport } from "../providers/transport.js";
import { admitReplay, parseReplayJson, replayDigest } from "./judge-replay-input.js";
import { prepareReplayProvider } from "./judge-replay-provider.js";
import { replayJudgments } from "./judge-replay-run.js";

export interface JudgeReplayOptions {
  corpus: string;
  review: string;
  policy: string;
  output: string;
  execute?: boolean;
  costPolicy?: string;
  costLedger?: string;
  costFileId?: string;
}

/** Resolve the explicitly selected replay backend without provider fallthrough. */
export function resolveReplayProviderConfig(
  provider: "deepseek" | "groq" | "nvidia" | "cloudflare",
  env: NodeJS.ProcessEnv,
): OpenAICompatConfig | null {
  if (provider !== "cloudflare") return resolveOpenAICompatConfig(env, provider);

  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId) || !apiToken || apiToken.length < 8) {
    return null;
  }
  return {
    name: "cloudflare",
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    apiKey: apiToken,
    defaultModel: "@cf/thinkingmachines/inkling-2-small",
  };
}

export function replayReadFlags(
  primitives: { O_RDONLY?: number; O_NOFOLLOW?: number; O_NONBLOCK?: number } = constants,
): number {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = primitives;
  if (
    !Number.isSafeInteger(O_RDONLY) ||
    O_RDONLY! < 0 ||
    !Number.isSafeInteger(O_NOFOLLOW) ||
    O_NOFOLLOW! <= 0 ||
    !Number.isSafeInteger(O_NONBLOCK) ||
    O_NONBLOCK! <= 0
  ) {
    throw new Error("Replay requires supported no-follow and nonblocking file primitives");
  }
  return O_RDONLY! | O_NOFOLLOW! | O_NONBLOCK!;
}

/** Descriptor-bound, bounded UTF-8 input; no FIFO wait or final-component symlink. */
export function readReplayDocument(path: string): string {
  const limit = 4 * 1024 * 1024;
  const fd = openSync(path, replayReadFlags());
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Replay input must be a regular file of at most 4 MiB");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw new Error("Replay input grew beyond 4 MiB");
    if (length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error("Replay UTF-8 input must not contain a BOM");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

function publish(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const bytes = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  return replayDigest(bytes);
}

export async function runJudgeReplay(
  options: JudgeReplayOptions,
  dependencies: {
    env?: NodeJS.ProcessEnv;
    transport?: Transport;
    signal?: AbortSignal;
    now?: Date;
  } = {},
) {
  const corpusBytes = readReplayDocument(options.corpus);
  const reviewBytes = readReplayDocument(options.review);
  const input = admitReplay(
    corpusBytes,
    reviewBytes,
    parseReplayJson(readReplayDocument(options.policy)),
    dependencies.now ?? new Date(),
  );
  const output = resolve(options.output);
  if (options.execute && (!options.costPolicy || !options.costLedger || !options.costFileId)) {
    throw new Error("Execution requires explicit cost policy, ledger and file identity");
  }
  // Admission and all source reads precede creation; existing output is never overwritten.
  mkdirSync(output, { mode: 0o700 });
  writeFileSync(join(output, "corpus.json"), corpusBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(join(output, "review.json"), reviewBytes, { flag: "wx", mode: 0o600 });
  const plan = {
    schema: "j-rig/judge-replay-plan/v1",
    status: "planned",
    executed: false,
    execution_requested: options.execute === true,
    corpus_sha256: input.corpusHash,
    review_sha256: input.reviewHash,
    policy_sha256: input.policyHash,
    policy: input.policy,
    pacing: input.pacing,
    planned_calls: input.plannedCalls,
    human_provenance: "caller-attested-not-cryptographically-verified",
    cost_admission: "not-opened",
    source_provenance: "caller-asserted-artifact-not-loaded",
  };
  publish(join(output, "plan.json"), plan);
  if (!options.execute) return { status: "planned", exitCode: 0, output };

  let session: CostSession | undefined;
  let provider: ReturnType<typeof prepareReplayProvider> | undefined;
  let stage = "provider-configuration";
  let costOutcome: ReturnType<typeof recordCostOutcome>;
  try {
    const config = resolveReplayProviderConfig(
      input.policy.provider,
      dependencies.env ?? process.env,
    );
    if (!config) throw new Error("Requested replay provider is not configured");
    stage = "cost-session-admission";
    session = openCostSession({
      policyPath: resolve(options.costPolicy!),
      ledgerPath: resolve(options.costLedger!),
      fileId: options.costFileId!,
      attemptId: randomUUID(),
    });
    stage = "provider-admission";
    provider = prepareReplayProvider(input, config, session, {
      transport: dependencies.transport,
      signal: dependencies.signal,
    });
    stage = "execution";
    const report = await replayJudgments(input, provider.judge, provider.beforeSample);
    costOutcome = recordCostOutcome(session, report.status === "completed" ? "scored" : "failed");
    stage = "report-publication";
    publish(join(output, "report.json"), {
      ...report,
      identity: provider.identity,
      wire_calls: provider.wireCalls(),
      cost: costOutcome,
      source_provenance: plan.source_provenance,
      human_provenance: plan.human_provenance,
      cost_interpretation:
        "caller-supplied rate estimate and reservation ledger, not a billing invoice",
      verified_billing: "unavailable",
    });
    return { status: report.status, exitCode: report.status === "completed" ? 0 : 2, output };
  } catch (error) {
    if (!costOutcome) {
      try {
        costOutcome = recordCostOutcome(session, "failed");
      } catch {
        // Preserve refusal even if a damaged ledger cannot accept an outcome.
      }
    }
    // A sealed scored outcome is retained if report publication fails; never rewrite it.
    publish(join(output, "failure.json"), {
      schema: "j-rig/judge-replay-failure/v1",
      status: "failed",
      execution_requested: true,
      stage,
      wire_calls: provider?.wireCalls() ?? 0,
      cost_outcome: costOutcome?.decision ?? "unavailable",
      corpus_sha256: input.corpusHash,
      review_sha256: input.reviewHash,
      policy_sha256: input.policyHash,
    });
    throw error;
  }
}

export function registerJudgeReplayCommand(program: Command): void {
  program
    .command("judge-replay")
    .description(
      "Plan a private fixed-output judge replay; --execute explicitly enables native calls",
    )
    .requiredOption("--corpus <path>", "Immutable fixed-output JSON corpus")
    .requiredOption("--review <path>", "Human-attested binary labels bound to exact corpus bytes")
    .requiredOption("--policy <path>", "Explicit model, sample, pacing and invocation bounds")
    .requiredOption("--output <path>", "New private output directory (must not exist)")
    .option(
      "--execute",
      "Execute the reviewed plan; otherwise no credentials or transport are used",
    )
    .option("--cost-policy <path>", "Explicit governed native cost policy")
    .option("--cost-ledger <path>", "Reservation ledger path")
    .option("--cost-file-id <id>", "File identity enrolled in the cost policy")
    .action(async (options: JudgeReplayOptions) => {
      try {
        const result = await runJudgeReplay(options);
        console.log(JSON.stringify(result));
        process.exitCode = result.exitCode;
      } catch {
        console.error("Judge replay refused or failed; no completed comparison is claimed.");
        process.exitCode = 2;
      }
    });
}
