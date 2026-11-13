import {
  createCostTransport,
  CostAdmissionError,
  type CostSession,
} from "@intentsolutions/refiner";
import { hashValue } from "@intentsolutions/refiner-core";
import { RequestPacer } from "../providers/request-pacing.js";
import {
  RealOpenAICompatProvider,
  OpenAICompatJudgeProvider,
  type OpenAICompatConfig,
} from "../providers/openai-compatible.js";
import { createFetchTransport, type Transport } from "../providers/transport.js";
import { replayDigest, type AdmittedReplay } from "./judge-replay-input.js";

/** The first bounded lane uses the existing native OpenAI-compatible judge bridge. */
export function prepareReplayProvider(
  input: AdmittedReplay,
  config: OpenAICompatConfig,
  session: CostSession,
  options: { transport?: Transport; signal?: AbortSignal; now?: () => number } = {},
) {
  if (config.name !== input.policy.provider) throw new Error("Replay provider identity mismatch");
  const state = session.ledger.snapshot();
  const rate = state.policy.rates.find(
    (item) => item.provider === config.name && item.model === input.policy.model,
  );
  if (!rate || rate.format !== "openai")
    throw new Error("Replay requires an explicit matching native cost rate");
  if (state.policy.maxFileTokens === undefined || state.policy.maxFileAttempts === undefined) {
    throw new Error("Replay requires explicit governed file token and attempt bounds");
  }
  const now = options.now ?? (() => performance.now());
  const started = now();
  const wall = AbortSignal.timeout(input.policy.max_wall_ms);
  const signal = options.signal ? AbortSignal.any([options.signal, wall]) : wall;
  let wireCalls = 0;
  const beforeSample = () => {
    signal.throwIfAborted();
    if (now() - started >= input.policy.max_wall_ms || wireCalls >= input.policy.max_calls) {
      throw new CostAdmissionError("Replay invocation limit reached");
    }
  };
  const wire = options.transport ?? createFetchTransport();
  const governed = createCostTransport<Parameters<Transport>[0], Awaited<ReturnType<Transport>>>(
    (request) => {
      wireCalls++;
      return wire(request);
    },
    session.ledger,
    {
      ...session.context,
      provider: config.name,
      format: "openai",
      phase: "judge",
      beforeAdmission: beforeSample,
    },
  );
  const pacer = new RequestPacer(input.pacing);
  pacer.selectEndpoint(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`);
  const transport = pacer.wrap(governed, {
    beforeDispatch: beforeSample,
    remainingWallMs: () => input.policy.max_wall_ms - (now() - started),
  });
  const combined: Transport = (request) =>
    transport({
      ...request,
      signal: request.signal ? AbortSignal.any([request.signal, signal]) : signal,
    });
  const native = new RealOpenAICompatProvider({
    name: config.name,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    transport: combined,
  });
  return {
    judge: new OpenAICompatJudgeProvider(input.policy.model, native),
    beforeSample,
    identity: {
      provider: config.name,
      model: input.policy.model,
      endpoint_sha256: replayDigest(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`),
      cost_policy_sha256: hashValue(state.policy),
      file_id: session.context.fileId,
      attempt_id: session.context.attemptId,
    },
    wireCalls: () => wireCalls,
  };
}
