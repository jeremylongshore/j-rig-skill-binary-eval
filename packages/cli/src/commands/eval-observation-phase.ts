import {
  runFunctionalTests,
  type ObservedOutcome,
  type ExecutionProvider,
  type ReasoningEffort,
} from "@j-rig/core";
import type { ParsedSkill, SkillEvalSpec } from "../lib/loaders.js";
import type { EvalCostMeter } from "../providers/cost-tracking.js";
import type { loadMcpRuntime } from "../execution/mcp-runtime.js";
import { storeToolExecutionEvidence } from "../execution/evidence.js";
import type { EvalInfrastructureFailure } from "./eval-infrastructure-failure.js";

interface ObservationPhaseInput {
  costMeter: EvalCostMeter;
  admissionActive: boolean;
  triggerFailure: EvalInfrastructureFailure | null;
  spec: SkillEvalSpec;
  skill: ParsedSkill;
  providers: { execution: ExecutionProvider };
  model: string;
  toolConfig?: Awaited<ReturnType<typeof loadMcpRuntime>>;
  database: Parameters<typeof storeToolExecutionEvidence>[0];
  opts: { db: string; json?: boolean; traceBoundary?: boolean };
  runId: number;
  executionParameters?: { reasoning_effort: ReasoningEffort };
}

/** Capture the execution leg and its tool/boundary evidence before judging. */
export async function observeFunctionalPhase(input: ObservationPhaseInput) {
  const {
    costMeter,
    admissionActive,
    triggerFailure,
    spec,
    skill,
    providers,
    model,
    toolConfig,
    database,
    opts,
    runId,
    executionParameters,
  } = input;
  costMeter.phase = "execution";
  const outcomes: ObservedOutcome[] =
    admissionActive && triggerFailure
      ? []
      : await runFunctionalTests(spec.test_cases, skill, providers.execution, {
          model,
          // Pin execution to greedy decoding unless the spec opts into
          // sampling: at the API default (~1.0) the OUTPUT being judged
          // is a fresh random draw every run — verdict variance that no
          // amount of judge stabilization can absorb.
          temperature: spec.execution_temperature ?? 0,
          ...(toolConfig ? { tool_runtime: toolConfig.runtime } : {}),
        });
  const toolReceipts = toolConfig
    ? [
        storeToolExecutionEvidence(
          database,
          opts.db,
          runId,
          "skill",
          toolConfig.fingerprint,
          outcomes,
          !!toolConfig.runtime.judgeObservations,
          toolConfig.runtime.limits.maxTotalBytes,
          executionParameters,
        ),
      ]
    : [];

  if (!opts.json) {
    console.log(`  Functional: ${outcomes.length}/${spec.test_cases.length} test case(s) executed`);
  }

  // ── Empty-output boundary instrumentation (bd_000-projects-0xttn) ──
  // Without --mcp-config, a single-turn completion captures text but cannot
  // actually run a skill's tools/scripts, so tool/script-dependent
  // skills surface here as empty/short text with zero tool calls, a
  // `timed_out` meta, a captured `output.error`, or a non-`completed`
  // status. Characterizing that boundary is a precondition for the
  // batch-grade phase (h08j.4): it names the cases a completion-only
  // eval can't fully grade, instead of silently judging a degenerate
  // empty response as if it were a real skill run.
  // `text` is typed as string, but an external provider could return
  // null/undefined; coalesce so the boundary check never throws.
  const boundaryText = (o: ObservedOutcome) => o.output.text ?? "";
  const boundaryCases = outcomes.filter(
    (o) =>
      o.status !== "completed" ||
      o.meta.timed_out ||
      boundaryText(o).trim() === "" ||
      Boolean(o.output.error),
  );
  // Per-case detail goes to STDERR (the diagnostic channel) so it
  // never corrupts machine-readable stdout under --json.
  if (opts.traceBoundary) {
    for (const o of outcomes) {
      console.error(
        `  [boundary] ${o.test_case_id} model=${model} status=${o.status} ` +
          `timed_out=${o.meta.timed_out} text_len=${boundaryText(o).length} ` +
          `tool_calls=${o.output.tool_calls} empty_output=${boundaryText(o).trim() === ""}` +
          (o.output.error ? ` error=${JSON.stringify(o.output.error)}` : ""),
      );
    }
  }
  if (boundaryCases.length > 0 && !opts.json) {
    console.log(
      `  Boundary: ${boundaryCases.length}/${outcomes.length} test case(s) hit an ` +
        `empty-output / tool-dependent boundary a completion-only eval can't fully grade ` +
        `[${boundaryCases.map((o) => o.test_case_id).join(", ")}]` +
        (opts.traceBoundary ? "" : " — re-run with --trace-boundary for per-case detail."),
    );
  }

  return { outcomes, toolReceipts };
}
