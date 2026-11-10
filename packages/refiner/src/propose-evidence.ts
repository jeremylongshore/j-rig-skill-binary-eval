import { randomUUID } from "node:crypto";
import {
  hashValue,
  type ProposeContext,
  type RefinerStrategy,
  type EditProposal,
} from "@intentsolutions/refiner-core";
import {
  completeWithMeasurement,
  propose,
  type CompletionClient,
  type ProposeModelOptions,
  type CompletionRequest,
} from "./propose.js";
import type { RefinerStore } from "./store.js";

/**
 * Persist intent before I/O and an outcome after each call. Started-only entries
 * mean unknown billing after interruption, not zero. No automatic retries.
 * Receipt fields exclude credentials, endpoint URLs, prompts, responses and errors.
 */
export async function proposeWithEvidence(
  strategy: RefinerStrategy,
  ctx: Omit<ProposeContext, "model">,
  client: CompletionClient,
  store: RefinerStore,
  opts: ProposeModelOptions = {},
  runtime: { now?: () => string; id?: () => string; provider?: string } = {},
): Promise<{ proposal: EditProposal; receiptHash: string }> {
  const now = runtime.now ?? (() => new Date().toISOString());
  const runId = (runtime.id ?? randomUUID)();
  const calls: string[] = [];
  let sequence = 0;
  const complete = async (req: CompletionRequest) => {
    const start = {
      schema: "refiner-completion/v1",
      runId,
      sequence: sequence++,
      skillHash: ctx.doc.hash,
      strategyId: strategy.id,
      requestedModel: req.model,
      provider: runtime.provider ?? null,
      format: opts.format ?? "anthropic",
      maxTokens: req.maxTokens ?? null,
      promptHash: hashValue(req.prompt),
      at: now(),
      status: "started",
    };
    // If storage fails, no provider call is admitted.
    const startedHash = store.put("completion-attempt", start);
    let result;
    try {
      result = await completeWithMeasurement(client, req);
    } catch (error) {
      calls.push(
        store.put("completion-attempt", {
          ...start,
          startedHash,
          at: now(),
          status: "failed",
          measurement: null,
        }),
      );
      throw error;
    }
    calls.push(
      store.put("completion-attempt", {
        ...start,
        startedHash,
        at: now(),
        status: "completed",
        measurement: result.measurement,
      }),
    );
    return result;
  };
  const observed: CompletionClient = {
    complete: async (req) => (await complete(req)).text,
    completeWithUsage: complete,
  };
  let proposal: EditProposal;
  try {
    proposal = await propose(strategy, ctx, observed, opts);
  } catch (error) {
    store.put("proposal-attempt", {
      schema: "refiner-proposal-attempt/v1",
      runId,
      skillHash: ctx.doc.hash,
      strategyId: strategy.id,
      at: now(),
      calls,
      status: "failed",
      proposalHash: null,
    });
    throw error;
  }
  const proposalHash = store.putEditProposal(proposal);
  const receiptHash = store.put("proposal-attempt", {
    schema: "refiner-proposal-attempt/v1",
    runId,
    skillHash: ctx.doc.hash,
    strategyId: strategy.id,
    at: now(),
    calls,
    status: "proposed",
    proposalHash,
  });
  return { proposal, receiptHash };
}
