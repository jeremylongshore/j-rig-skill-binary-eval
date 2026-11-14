import { randomUUID } from "node:crypto";
import { hashValue } from "@intentsolutions/refiner-core";
import {
  checkedInputs,
  readEvaluationUsage,
  type EvalRunner,
  type EvalRunnerResult,
} from "./score.js";
import type { RefinerStore } from "./store.js";

/** Persist evaluator attempts even when scoring rejects the result or the subprocess fails. */
export function createAccountingEvalRunner(
  inner: EvalRunner,
  store: RefinerStore,
  context: { proposalHash?: string; experimentHash?: string } = {},
  runtime: { now?: () => string; id?: () => string } = {},
): EvalRunner & { readonly runId: string; readonly attemptCount: number } {
  const runId = (runtime.id ?? randomUUID)();
  const now = runtime.now ?? (() => new Date().toISOString());
  const attribution = structuredClone(context);
  let sequence = 0;
  return {
    runId,
    get attemptCount() {
      return sequence;
    },
    async run(input) {
      const frozen = structuredClone(input);
      const { doc, evalSet } = checkedInputs(frozen.doc, frozen.evalSet);
      const started = {
        schema: "refiner-evaluation-attempt/v1",
        runId,
        sequence: sequence++,
        skillId: doc.skillId,
        skillHash: doc.hash,
        evalSetHash: evalSet.hash,
        provider: frozen.provider ?? null,
        requestedModel: frozen.modelTier,
        judgeProvider: frozen.judgeProvider ?? null,
        judgeModel: frozen.judgeModel ?? null,
        proposalHash: attribution.proposalHash ?? null,
        experimentHash: attribution.experimentHash ?? null,
        inputHash: hashValue({ doc, evalSet }),
        status: "started",
        at: now(),
      };
      const startedHash = store.put("evaluation-attempt", started);
      let result: EvalRunnerResult;
      try {
        result = await inner.run(frozen);
      } catch (error) {
        store.put("evaluation-attempt", {
          ...started,
          startedHash,
          at: now(),
          status: "failed",
          exitCode: null,
          usage: { status: "missing", evidence: null },
        });
        throw error;
      }
      store.put("evaluation-attempt", {
        ...started,
        startedHash,
        at: now(),
        status: result.exitCode === 0 ? "completed" : "failed",
        exitCode: result.exitCode,
        usage: readEvaluationUsage(result.stdout, frozen.modelTier),
      });
      return result;
    },
  };
}
