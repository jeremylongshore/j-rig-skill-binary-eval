import { evaluateOutcomeJudgments } from "./eval-judgments.js";
import { finalizeEvaluation } from "./eval-finalize.js";
import { evaluateDeclaredSelfTest } from "./eval-self-test.js";
import { reportEvalCost } from "./eval-cost-report.js";
import { buildVoteEvidence } from "./eval-vote-evidence.js";
import {
  positiveNumber,
  resolveExecutionParameters,
  resolveSpecOptions,
} from "./eval-preflight.js";
export { resolveRunBudgetLimits } from "./eval-preflight.js";
import { costStopMicros, hashValue as hashRefinerValue } from "@intentsolutions/refiner-core";
import {
  createCostTransport,
  CostAdmissionError,
  openCostSession,
  type CostSession,
} from "@intentsolutions/refiner";
import { createFetchTransport } from "../providers/transport.js";
import { retainRolloutRun, type RetainedRolloutRun } from "./rollout-export.js";
import type { ReasoningEffort } from "@j-rig/core";
import { storeTriggerEvidence } from "./trigger-evidence.js";
import { loadMcpRuntime } from "../execution/mcp-runtime.js";
import { getJudgeObservations, storeToolExecutionEvidence } from "../execution/evidence.js";
import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  checkPackage,
  buildRoster,
  runTriggerTests,
  computeMetrics,
  runFunctionalTests,
  judgeCriteria,
  selectCriteriaForTestCase,
  computeScoreCard,
  decideRollout,
  buildLaunchReport,
  assessHeadroom,
  detectRegressions,
  compareBaseline,
  isObsoleteCandidate,
  uuidv7,
  ProviderError,
  emitRuntimeRunStarted,
  emitRuntimeRunFinished,
  emitRuntimeCriterionEvaluated,
  emitGateDecisionEmitted,
  buildSkillPromotionEvidence,
  composeStatement,
  hashCanonicalJson,
  RuntimeTerminalState,
  CriterionOutcome,
  GateDecision,
  type EvalCorrelation,
} from "@j-rig/core";
import type {
  JudgmentResult,
  ObservedOutcome,
  EvidenceStatement,
  Regression,
  BaselineComparison,
  TriggerResult,
} from "@j-rig/core";
import {
  getOrCreateSkillVersion,
  createRun,
  transitionRun,
  storeCriterionResults,
  storeRunSummary,
} from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { loadSkillEvalSpec, loadSkillMd } from "../lib/loaders.js";
import { printReport, header, formatDecision, formatScore, icon } from "../lib/output.js";
import {
  StubTriggerProvider,
  StubExecutionProvider,
  StubJudgeProvider,
  assertStubAllowed,
} from "../providers/anthropic.js";
import {
  RealAnthropicProvider,
  resolveAnthropicModel,
  AnthropicTriggerProvider,
  AnthropicExecutionProvider,
  AnthropicJudgeProvider,
} from "../providers/anthropic-real.js";
import {
  RealOpenAICompatProvider,
  OpenAICompatTriggerProvider,
  OpenAICompatExecutionProvider,
  OpenAICompatJudgeProvider,
  resolveOpenAICompatConfig,
} from "../providers/openai-compatible.js";
import {
  CLAUDE_CODE_PROVIDER_NAME,
  ClaudeCodeExecutionProvider,
  type ClaudeCodeMeasurement,
} from "../providers/claude-code.js";
import type { TriggerProvider, ExecutionProvider, JudgeProvider, Provider } from "@j-rig/core";
import type { HeadroomAssessment } from "@j-rig/core";
import {
  detectInfrastructureFailure,
  infrastructureFailureReason,
  isFailedExecution,
} from "./eval-infrastructure-failure.js";
import {
  CostTrackingProvider,
  EvalCostMeter,
  type EvalCostReport,
} from "../providers/cost-tracking.js";
import {
  BudgetGuardedExecutionProvider,
  BudgetGuardedProvider,
  RunBudget,
  type BudgetStop,
} from "../providers/budget.js";

export interface EvalOptions {
  spec?: string;
  models: string;
  db: string;
  json?: boolean;
  trigger?: boolean;
  functional?: boolean;
  provider?: string;
  emitBundle?: string;
  rolloutFile?: string;
  traceBoundary?: boolean;
  mcpConfig?: string;
  executionReasoningEffort?: string;
  runSelfTest?: boolean;
  requireReviewed?: boolean;
  samples?: string;
  judgeProvider?: string;
  judgeModel?: string;
  baselineCheck?: boolean;
  regressionBaseline?: string;
  executionProvider?: string;
  workspaceFixtures?: string;
  claudeCodeMaxTurns?: string;
  claudeCodeTimeoutMs?: string;
  claudeCodeMaxBudgetUsd?: string;
  keepWorkspaces?: boolean;
  maxUsd?: string;
  maxTokens?: string;
  maxWallMs?: string;
  maxCalls?: string;
}

/** Validated `--execution-provider claude-code` settings (see providers/claude-code.ts). */
interface ClaudeCodeSettings {
  skillDir: string;
  skillName: string;
  fixturesDir?: string;
  maxTurns?: number;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  keepWorkspaces?: boolean;
}

/**
 * Resolve the execution-leg override. Only `claude-code` exists today; it
 * swaps ONLY the execution leg (trigger and judge stay on --provider), the
 * same decoupling --judge-provider applies to the judge leg.
 */
export function resolveClaudeCodeSettings(
  opts: Pick<
    EvalOptions,
    | "executionProvider"
    | "workspaceFixtures"
    | "claudeCodeMaxTurns"
    | "claudeCodeTimeoutMs"
    | "claudeCodeMaxBudgetUsd"
    | "keepWorkspaces"
    | "executionReasoningEffort"
    | "mcpConfig"
    | "functional"
  >,
): Omit<ClaudeCodeSettings, "skillDir" | "skillName"> | undefined {
  const want = opts.executionProvider?.trim().toLowerCase();
  const ccFlags =
    opts.workspaceFixtures !== undefined ||
    opts.claudeCodeMaxTurns !== undefined ||
    opts.claudeCodeTimeoutMs !== undefined ||
    opts.claudeCodeMaxBudgetUsd !== undefined ||
    opts.keepWorkspaces === true;
  if (want === undefined || want === "") {
    if (ccFlags) {
      throw new Error(
        "--workspace-fixtures, --claude-code-* and --keep-workspaces require --execution-provider claude-code",
      );
    }
    return undefined;
  }
  if (want !== CLAUDE_CODE_PROVIDER_NAME) {
    throw new Error(`--execution-provider must be "claude-code", got "${opts.executionProvider}"`);
  }
  if (opts.functional === false) {
    throw new Error("--execution-provider claude-code requires functional execution");
  }
  if (opts.executionReasoningEffort !== undefined || opts.mcpConfig !== undefined) {
    throw new Error(
      "--execution-provider claude-code cannot be combined with --execution-reasoning-effort or --mcp-config",
    );
  }
  const maxTurns = positiveNumber("--claude-code-max-turns", opts.claudeCodeMaxTurns, true);
  const timeoutMs = positiveNumber("--claude-code-timeout-ms", opts.claudeCodeTimeoutMs, true);
  const maxBudgetUsd = positiveNumber(
    "--claude-code-max-budget-usd",
    opts.claudeCodeMaxBudgetUsd,
    false,
  );
  return {
    ...(opts.workspaceFixtures !== undefined
      ? { fixturesDir: resolve(opts.workspaceFixtures) }
      : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(opts.keepWorkspaces ? { keepWorkspaces: true } : {}),
  };
}

/** The three eval-pipeline providers a single run needs, plus run metadata. */
interface SelectedProviders {
  trigger: TriggerProvider;
  execution: ExecutionProvider;
  judge: JudgeProvider;
  /** true = real model API (ground truth); false = stub (NOT ground truth). */
  real: boolean;
  /** Short provider name recorded in evidence (`anthropic`/`deepseek`/`stub`/…). */
  providerName: string;
  /**
   * Judge backend name — equals `providerName` unless `--judge-provider`
   * decoupled the judge from the execution model (the judge value benchmark:
   * a weak judge gives wrong verdicts, so the judge is independently
   * swappable).
   */
  judgeProviderName: string;
  /** Concrete model id the judge runs on — feeds JudgmentResult.judge_model + OTel. */
  judgeModelId: string;
}

/** Extra provider-selection inputs: cost metering + judge decoupling. */
interface GovernedCostSession extends CostSession {
  providerFailed?: boolean;
  refused?: { phase: "trigger" | "execution" | "judge" };
}
interface ProviderExtras {
  costSession?: GovernedCostSession;
  executionReasoningEffort?: ReasoningEffort;
  meter?: EvalCostMeter;
  /** Pre-call spend/latency guard; wraps outside the meter (providers/budget.ts). */
  budget?: RunBudget;
  judgeProvider?: string;
  judgeModel?: string;
  claudeCode?: ClaudeCodeSettings;
}

/**
 * Resolve an INDEPENDENT judge backend when `--judge-provider`/`--judge-model`
 * decouple the judge from the skill-under-test's provider. Fails LOUD when the
 * requested backend has no key — silently judging on a different vendor than
 * asked would corrupt the benchmark this exists for.
 */
/** Meter every real provider call, then guard it with the budget (a refused call is never spend). */
function wrapMetered(p: Provider, extras: ProviderExtras | undefined): Provider {
  const metered = extras?.meter
    ? new CostTrackingProvider(p, extras.meter, (error) => {
        if (
          extras.costSession &&
          !(error instanceof CostAdmissionError) &&
          !(error instanceof ProviderError && error.originalError instanceof CostAdmissionError)
        )
          extras.costSession.providerFailed = true;
      })
    : p;
  return extras?.budget ? new BudgetGuardedProvider(metered, extras.budget) : metered;
}

function costTransport(
  extras: ProviderExtras | undefined,
  provider: string,
  format: "anthropic" | "openai",
) {
  if (!extras?.costSession) return undefined;
  const session = extras.costSession;
  return createCostTransport(createFetchTransport(), session.ledger, {
    ...session.context,
    provider,
    format,
    phase: () => extras.meter?.phase ?? "execution",
    beforeAdmission: () => {
      if (session.providerFailed)
        throw new CostAdmissionError("Stopped after a provider failure; no further wire calls");
    },
    onAdmissionRefused: () => {
      session.refused ??= { phase: extras.meter?.phase ?? "execution" };
    },
  });
}

export function selectJudgeOverride(
  targetModel: string,
  extras?: ProviderExtras,
): { judge: JudgeProvider; name: string; modelId: string } | null {
  const judgeProvider = extras?.judgeProvider?.trim().toLowerCase();
  const judgeModel = extras?.judgeModel?.trim();
  if (!judgeProvider && !judgeModel) return null;

  const wrap = (p: Provider): Provider => wrapMetered(p, extras);

  if (judgeProvider === "stub") {
    if (extras?.costSession) throw new Error("Governed cost mode requires a real native judge");
    const modelId = judgeModel || targetModel;
    return { judge: new StubJudgeProvider(modelId), name: "stub", modelId };
  }

  if (judgeProvider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.length < 8) {
      throw new Error("--judge-provider anthropic requires ANTHROPIC_API_KEY");
    }
    const provider = wrap(
      new RealAnthropicProvider({
        apiKey,
        transport: costTransport(extras, "anthropic", "anthropic"),
      }),
    );
    const modelId = resolveAnthropicModel(judgeModel || targetModel);
    return { judge: new AnthropicJudgeProvider(modelId, provider), name: "anthropic", modelId };
  }

  // Preset / generic OpenAI-compatible path. `--judge-model` alone rides the
  // auto-detected OpenAI-compatible backend (Anthropic fallback below).
  const cfg = resolveOpenAICompatConfig(process.env, judgeProvider);
  if (cfg) {
    const provider = wrap(
      new RealOpenAICompatProvider({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        name: cfg.name,
        transport: costTransport(extras, cfg.name, "openai"),
        minimaxPlanAdmission: process.env.JRIG_MINIMAX_PLAN_ADMISSION === "1",
      }),
    );
    const modelId = judgeModel || cfg.defaultModel || targetModel;
    return { judge: new OpenAICompatJudgeProvider(modelId, provider), name: cfg.name, modelId };
  }
  if (!judgeProvider) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && apiKey.length >= 8) {
      const provider = wrap(
        new RealAnthropicProvider({
          apiKey,
          transport: costTransport(extras, "anthropic", "anthropic"),
        }),
      );
      const modelId = resolveAnthropicModel(judgeModel || targetModel);
      return { judge: new AnthropicJudgeProvider(modelId, provider), name: "anthropic", modelId };
    }
    if (extras?.costSession) throw new Error("Governed cost mode requires a real native judge");
    // `--judge-model` alone with NO real key anywhere: fall back to the stub
    // judge (its constructor enforces the J_RIG_ALLOW_STUB opt-in gate) so
    // the flag composes with stub/test environments, mirroring
    // selectProviders' fallback. Only an EXPLICIT --judge-provider fails loud.
    const modelId = judgeModel || targetModel;
    return { judge: new StubJudgeProvider(modelId), name: "stub", modelId };
  }
  throw new Error(
    `--judge-provider "${judgeProvider}" requested but no API key resolves for it — ` +
      `set that preset's key env var (or drop the flag)`,
  );
}

/**
 * Select real vs stub providers for a model.
 *
 * Provider precedence (output IS ground truth on any real path):
 *   1. An OpenAI-compatible endpoint — DeepSeek, Kimi/Moonshot, OpenRouter, MiniMax,
 *      OpenAI, Groq, NVIDIA, or a generic `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY`
 *      triple. A `--provider`
 *      flag forces a specific preset. This is the default real path because the
 *      Anthropic external-API credit is exhausted; DeepSeek credits are live.
 *   2. The real Anthropic Messages API when `ANTHROPIC_API_KEY` is set.
 *   3. Stub fallback — only if the operator opted in via `J_RIG_ALLOW_STUB=1`.
 *      Without ANY real key AND without the opt-in, `assertStubAllowed()` throws
 *      REFUSED (synthetic ship verdicts are too costly to emit silently).
 *
 * `preferred` comes from the `--provider` flag: when it names a preset
 * (`deepseek`/`kimi`/`moonshot`/`openrouter`), only that preset is considered for
 * the OpenAI-compatible path; `anthropic` skips straight to the Anthropic path;
 * `stub` forces the stub path (still gated by the opt-in).
 */
function selectProviders(
  model: string,
  preferred?: string,
  extras?: ProviderExtras,
): SelectedProviders {
  if (extras?.costSession && extras.claudeCode)
    throw new Error("Subscription execution cannot enforce native wire reservations");
  const want = preferred?.trim().toLowerCase();
  const wrap = (p: Provider): Provider => wrapMetered(p, extras);

  const base = ((): SelectedProviders => {
    // Explicit stub request — let the stub constructors enforce the opt-in gate.
    if (want === "stub") {
      if (extras?.costSession) throw new Error("Governed cost mode requires native providers");
      if (extras?.executionReasoningEffort !== undefined) {
        throw new Error("--execution-reasoning-effort is unavailable with stub execution");
      }
      return {
        trigger: new StubTriggerProvider(model),
        execution: new StubExecutionProvider(model),
        judge: new StubJudgeProvider(model),
        real: false,
        providerName: "stub",
        judgeProviderName: "stub",
        judgeModelId: model,
      };
    }

    // 1. OpenAI-compatible path (DeepSeek / Kimi / OpenRouter / Groq / NVIDIA /
    // generic LLM_*). Skipped only when the operator explicitly asked for
    // `anthropic`.
    if (want !== "anthropic") {
      const cfg = resolveOpenAICompatConfig(process.env, want);
      if (cfg) {
        // The --models target (haiku/sonnet/opus) is an Anthropic-only label and is
        // NOT a valid vendor model id on the OpenAI-compatible path — sending it to
        // Groq/DeepSeek 404s. Use the configured vendor model (LLM_MODEL / preset
        // defaultModel); fall back to the target only if no vendor model is set.
        const effectiveModel =
          cfg.defaultModel && cfg.defaultModel.length > 0 ? cfg.defaultModel : model;
        const provider = wrap(
          new RealOpenAICompatProvider({
            apiKey: cfg.apiKey,
            baseUrl: cfg.baseUrl,
            name: cfg.name,
            transport: costTransport(extras, cfg.name, "openai"),
            minimaxPlanAdmission: process.env.JRIG_MINIMAX_PLAN_ADMISSION === "1",
          }),
        );
        return {
          trigger: new OpenAICompatTriggerProvider(effectiveModel, provider),
          execution: new OpenAICompatExecutionProvider(
            effectiveModel,
            provider,
            extras?.executionReasoningEffort,
          ),
          judge: new OpenAICompatJudgeProvider(effectiveModel, provider),
          real: true,
          providerName: cfg.name,
          judgeProviderName: cfg.name,
          judgeModelId: effectiveModel,
        };
      }
    }

    if (extras?.executionReasoningEffort !== undefined) {
      throw new Error(
        "--execution-reasoning-effort requires a real OpenAI-compatible execution provider",
      );
    }

    // 2. Real Anthropic path.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && apiKey.length >= 8) {
      const provider = wrap(
        new RealAnthropicProvider({
          apiKey,
          transport: costTransport(extras, "anthropic", "anthropic"),
        }),
      );
      return {
        trigger: new AnthropicTriggerProvider(model, provider),
        execution: new AnthropicExecutionProvider(model, provider),
        judge: new AnthropicJudgeProvider(resolveAnthropicModel(model), provider),
        real: true,
        providerName: "anthropic",
        judgeProviderName: "anthropic",
        judgeModelId: resolveAnthropicModel(model),
      };
    }

    if (extras?.costSession) throw new Error("Governed cost mode requires native providers");
    // 3. No real key — stub providers (each constructor re-asserts the opt-in gate).
    return {
      trigger: new StubTriggerProvider(model),
      execution: new StubExecutionProvider(model),
      judge: new StubJudgeProvider(model),
      real: false,
      providerName: "stub",
      judgeProviderName: "stub",
      judgeModelId: model,
    };
  })();

  // Execution decoupling: `--execution-provider claude-code` swaps ONLY the
  // execution leg for a real Claude Code run (subscription auth, recorded
  // trajectory); trigger + judge stay on the base backend.
  const cc = extras?.claudeCode;
  const claudeCode = cc
    ? new ClaudeCodeExecutionProvider({
        ...cc,
        model,
        ...(extras?.meter
          ? {
              onAttempt: (requestedModel: string) => {
                const sequence = extras.meter!.begin(requestedModel, CLAUDE_CODE_PROVIDER_NAME);
                return (measurement: ClaudeCodeMeasurement) =>
                  extras.meter!.finish(
                    sequence,
                    measurement.usage,
                    measurement.outcome,
                    measurement.reportedModel ?? undefined,
                  );
              },
            }
          : {}),
      })
    : undefined;
  const withExecution: SelectedProviders = claudeCode
    ? {
        ...base,
        execution: extras?.budget
          ? new BudgetGuardedExecutionProvider(claudeCode, extras.budget)
          : claudeCode,
      }
    : base;

  // Judge decoupling: `--judge-provider` / `--judge-model` swap ONLY the judge
  // leg; trigger + execution stay on the base backend.
  const override = selectJudgeOverride(model, extras);
  if (override) {
    return {
      ...withExecution,
      judge: override.judge,
      judgeProviderName: override.name,
      judgeModelId: override.modelId,
    };
  }
  return withExecution;
}

/**
 * Does the environment (and the optional `--provider` preference) expose ANY
 * real provider key? Used to decide whether to short-circuit with the stub
 * opt-in assertion before expensive I/O.
 */
function hasAnyRealKey(preferred?: string): boolean {
  const want = preferred?.trim().toLowerCase();
  if (want === "stub") return false;
  if (want !== "anthropic" && resolveOpenAICompatConfig(process.env, want)) return true;
  if (want === "anthropic" || want === undefined || want === "") {
    return (process.env.ANTHROPIC_API_KEY?.length ?? 0) >= 8;
  }
  return false;
}

/**
 * Register the `eval` command on the given Commander program.
 *
 * Orchestrates the evaluation layers for a skill. All 7 are wired; 5 run by default
 * (package-integrity, trigger, functional, rollout-safety, cost/latency) and layers 4 (regression,
 * via --regression-baseline) and 5 (baseline, via --baseline-check) are opt-in. Every run declares
 * its actual coverage in the evidence bundle's `coverage.dimensionsSkipped`, so this never claims to
 * have scored a layer it skipped:
 *   1. Package integrity (deterministic)
 *   2. Trigger simulation (per model)
 *   3. Functional execution (per model)
 *   4. Judgment (per outcome × criterion)
 *   5. Scoring / governance
 *   6. Evidence persistence (SQLite)
 *   7. Launch report + rollout decision
 *
 * Exit codes:
 *   0 — evaluation complete (decision may be warn/obsolete_review)
 *   1 — package integrity hard failure, or unexpected runtime error
 */

/**
 * Resolve a kernel-valid `commit_sha` (7..40 lowercase hex) for the
 * gate-result/v1 predicate, honestly reporting where it came from.
 *
 * Precedence: explicit override → the skill directory's git HEAD (the commit
 * the gate actually evaluated against) → a content-derived 40-hex slice of the
 * skill snapshot sha (for skills that are not git-tracked, e.g. authored in
 * `~/.claude/skills/`). The fallback is NOT a real commit; the source string is
 * recorded in the predicate `metadata.commit_sha_source` so a reader is never
 * misled into treating it as one.
 */
function resolveCommitSha(
  skillDir: string,
  snapshotPrefixed: string,
): { sha: string; source: string } {
  const HEX = /^[a-f0-9]{7,40}$/;
  const env = process.env.JRIG_COMMIT_SHA?.trim();
  if (env && HEX.test(env)) return { sha: env, source: "env:JRIG_COMMIT_SHA" };
  try {
    const head = execFileSync("git", ["-C", skillDir, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (/^[a-f0-9]{40}$/.test(head)) return { sha: head, source: "git:skill-dir-HEAD" };
  } catch {
    /* skill not git-tracked — fall through to the content-derived slice */
  }
  // snapshotPrefixed is "sha256:" + 64 lowercase hex; take the first 40 hex.
  return {
    sha: snapshotPrefixed.slice("sha256:".length, "sha256:".length + 40),
    source: "skill-content-sha (skill not git-tracked)",
  };
}

/**
 * Sanitize an arbitrary string (skill name, model name) into a valid gate-id
 * trailing segment: chars limited to `[A-Za-z0-9.-]` and a leading
 * `[A-Za-z0-9]`, per the kernel SubjectName regex
 * `…:(client|server|ci|sandbox|local):[a-zA-Z0-9][a-zA-Z0-9.-]*`. Both the skill
 * name and the model are passed through this so a SKILL.md with a non-kebab
 * `name` (underscores, leading digit hyphen, etc.) can't produce a gate_id that
 * fails composeStatement's fail-closed validation.
 */
function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Load a prior run's judgments for the Layer-4 regression comparison
 * (--regression-baseline). Accepts a JSON array of { criterion_id, verdict };
 * only those two fields drive detectRegressions, so the loaded rows are minimal
 * JudgmentResults. Fails LOUD on a malformed file rather than silently skipping
 * the regression layer — a silent skip would hide a real regression.
 */
export function loadRegressionBaseline(path: string): JudgmentResult[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(
      `--regression-baseline: could not read/parse "${path}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      `--regression-baseline: "${path}" must be a JSON array of { criterion_id, verdict }`,
    );
  }
  const validVerdicts = new Set(["yes", "no", "unsure"]);
  return raw.map((row, i) => {
    const r = row as { criterion_id?: unknown; verdict?: unknown };
    if (
      typeof r.criterion_id !== "string" ||
      typeof r.verdict !== "string" ||
      !validVerdicts.has(r.verdict)
    ) {
      throw new Error(
        `--regression-baseline: entry ${i} in "${path}" needs a string criterion_id and a verdict of yes|no|unsure`,
      );
    }
    return {
      criterion_id: r.criterion_id,
      verdict: r.verdict as JudgmentResult["verdict"],
      confidence: 1,
      reasoning: "loaded from --regression-baseline",
      method: "judge" as const,
    };
  });
}

/**
 * One console line for an eval that has lost (or may have lost) its headroom.
 * `headroom` itself is the normal case and is not printed.
 */
export function formatHeadroom(h: HeadroomAssessment): string {
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  const rate = h.pass_rate === null ? "n/a" : pct(h.pass_rate);
  const ceiling = `${pct(h.ceiling)} (${h.ceiling_source})`;
  switch (h.status) {
    case "saturated":
      return `Eval saturated: ${h.passed}/${h.trials} criteria passed (${rate}) at or above the ${ceiling} ceiling; it cannot show that a change helped`;
    case "near_ceiling":
      return `Eval near ceiling: ${h.passed}/${h.trials} criteria passed (${rate}); the 95% interval reaches the ${ceiling} ceiling`;
    case "no_data":
      return "Eval headroom unknown: no criteria were scored";
    default:
      return `Eval has headroom: ${h.passed}/${h.trials} criteria passed (${rate}) below the ${ceiling} ceiling`;
  }
}

export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description(
      "Run the binary evaluation on a skill (5 of 7 layers by default; regression + baseline are opt-in, coverage reported in the evidence bundle)",
    )
    .argument("<skill-dir>", "Path to skill directory containing SKILL.md")
    .option("--spec <path>", "Path to eval spec YAML")
    .option(
      "--models <list>",
      "Comma-separated model list. Overrides the spec's `models` when given; " +
        "otherwise the spec's declared models are used (falling back to sonnet).",
      "sonnet",
    )
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--json", "Output as JSON")
    .option(
      "--rollout-file <path>",
      "Retain actual functional prompts and outputs for reviewed bootstrap; creates a private file without overwriting",
    )
    .option("--no-trigger", "Skip trigger tests")
    .option("--no-functional", "Skip functional tests")
    .option(
      "--provider <name>",
      "Force a provider: deepseek | kimi | moonshot | openrouter | groq | nvidia | openai | minimax | " +
        "anthropic | stub (default: auto-detect from env keys, preferring an OpenAI-compatible endpoint)",
    )
    .option(
      "--emit-bundle <path>",
      "Write a gate-result/v1 Evidence Bundle (JSON array of in-toto Statements, one per " +
        "model decision) to <path>. The bundle is kernel-validated on write (fail-closed) and " +
        "linked to each run as an artifact. Consumable directly by intent-rollout-gate.",
    )
    .option(
      "--execution-reasoning-effort <effort>",
      "Explicit reasoning mode for real OpenAI-compatible functional execution only: none | low | medium | high | max. The endpoint must support the selected value. Recorded in evidence; trigger and judge keep their defaults.",
    )
    .option(
      "--mcp-config <path>",
      "Explicit JSON stdio MCP server/tool allowlist for bounded functional execution. " +
        "Starts fresh configured server processes per case; judges receive no tools.",
    )
    .option(
      "--trace-boundary",
      "Log per-test-case execution boundary (text length, tool_calls, status, timed_out, " +
        "empty-output) for the functional pass. Characterizes tool/script-dependent skills a " +
        "single-turn completion eval cannot fully grade. A boundary summary always prints when " +
        "any case hits it; this flag adds the full per-case detail.",
    )
    .option(
      "--judge-provider <name>",
      "Judge on a DIFFERENT backend than the skill-under-test: deepseek | kimi | moonshot | minimax | " +
        "openrouter | groq | nvidia | openai | anthropic | stub. Trigger + execution stay on --provider's " +
        "backend. Fails loud if the requested judge backend has no key. (The judge value " +
        "benchmark: free multi-sampled judges vs a single paid judge.)",
    )
    .option(
      "--judge-model <id>",
      "Override the judge's model id (rides --judge-provider's backend when given, else the " +
        "auto-detected one).",
    )
    .option(
      "--samples <n>",
      "Judge samples per judge-method criterion (N-sample majority voting): the verdict is " +
        "the majority vote and `confidence` becomes the measured agreement fraction. " +
        "Overrides the spec's `samples`; a criterion's own `samples` overrides both. " +
        "Default: the spec's `samples`, else 1 (single call).",
    )
    .option(
      "--baseline-check",
      "Layer 5 (Baseline value): run an opt-in naked-model (empty skill body) comparison pass over " +
        "the same test cases; if the skill adds no value over the base model the run is flagged " +
        "obsolete_review. DOUBLES execution+judge cost. Off by default (baseline layer reported skipped).",
    )
    .option(
      "--regression-baseline <path>",
      "Layer 4 (Regression protection): path to a prior run's judgments — a JSON array of " +
        '{ "criterion_id": string, "verdict": "yes"|"no"|"unsure" }. A criterion that passed then and ' +
        "fails now is a regression; a SACRED (regression_critical) regression BLOCKS the rollout. " +
        "Omit to skip the regression layer (reported skipped).",
    )
    .option(
      "--run-self-test",
      "Execute the skill's declared `self_test.command` (a deterministic script) and fold its " +
        "exit-code verdict in as a binary `self-test` criterion — grading the script's observed " +
        "output, not the model's claim. OPT-IN: this runs a command the eval-spec declares, so " +
        "only pass it for skills you trust. The command runs shell-free, in the skill dir, with " +
        "a scoped env (no inherited API keys) and a timeout.",
    )
    .option(
      "--execution-provider <name>",
      "Run the EXECUTION leg on a different backend than --provider. `claude-code` runs each " +
        "test case in real Claude Code (`claude -p --output-format stream-json`) in a fresh temp " +
        "workspace with a copy of the skill, records every tool call and produced file (sha256), " +
        "and enables the trajectory checks (tool_called, tool_not_called, order_before, " +
        "file_exists, file_matches_sha_in). Local Claude subscription ONLY: refuses under CI and " +
        "never uses an API key. Trigger + judge stay on --provider.",
    )
    .option(
      "--workspace-fixtures <dir>",
      "claude-code: directory copied into every test case's workspace (no symlinks).",
    )
    .option(
      "--claude-code-max-turns <n>",
      "claude-code: per-case assistant-turn budget (default 25).",
    )
    .option(
      "--claude-code-timeout-ms <ms>",
      "claude-code: per-case wall-clock budget in ms (default 300000).",
    )
    .option(
      "--claude-code-max-budget-usd <usd>",
      "claude-code: per-case --max-budget-usd passed to Claude Code (API-equivalent $, default 1).",
    )
    .option("--keep-workspaces", "claude-code: keep each case's temp workspace for debugging.")
    .option(
      "--max-usd <usd>",
      "Run budget: stop cleanly once the API-equivalent spend reaches this many USD (all models, " +
        "all phases; subscription claude-code usage counts at list price). Fails closed when a " +
        "model has no rate on file. Tightens, never loosens, the spec's `budget`.",
    )
    .option("--max-tokens <n>", "Run budget: stop cleanly once input+output tokens reach n.")
    .option("--max-wall-ms <ms>", "Run budget: stop cleanly once the eval has run this long.")
    .option("--max-calls <n>", "Run budget: stop cleanly once n metered provider calls are made.")
    .option(
      "--require-reviewed",
      "Refuse a spec still tagged `needs-review` (a `scaffold-spec --draft` output nobody has " +
        "reviewed). The nightly roster passes this so unreviewed drafted criteria never gate.",
    )
    .action(async (skillDir: string, opts: EvalOptions, command: Command) => {
      const startTime = Date.now();

      try {
        // Provider selection (iaj-E10): when ANTHROPIC_API_KEY is set we run
        // the REAL Anthropic provider and the output is ground truth. Without
        // a key, stub mode is the only available path — and stub-mode opt-in is
        // enforced inside each stub provider constructor (IEP Convergence Debt
        // Plan Priority 2; the gate is structurally inviolable). A
        // belt-and-suspenders assertStubAllowed() is retained at the entry
        // point so the REFUSED error surfaces BEFORE expensive I/O when stub
        // mode is the only path — but ONLY when there is no real key, so a real
        // dogfood run is never gated behind J_RIG_ALLOW_STUB.
        const executionParameters = resolveExecutionParameters(opts, process.env);
        let executionMetadata: Record<string, unknown> = executionParameters
          ? { execution_parameters: executionParameters }
          : {};
        const claudeCodeSettings = resolveClaudeCodeSettings(opts);
        if (claudeCodeSettings) {
          executionMetadata = {
            ...executionMetadata,
            execution_provider: CLAUDE_CODE_PROVIDER_NAME,
          };
        }
        const hasRealKey = hasAnyRealKey(opts.provider);
        if (!hasRealKey) assertStubAllowed();
        if (
          opts.mcpConfig &&
          (!hasRealKey || opts.provider === "stub" || opts.functional === false)
        ) {
          throw new Error("--mcp-config requires real functional execution");
        }
        const toolConfig = opts.mcpConfig ? await loadMcpRuntime(opts.mcpConfig) : undefined;

        // ── Phase 1: Load ────────────────────────────────────────────────
        const absDir = resolve(skillDir);
        const { parsed: skill, raw: skillContent } = loadSkillMd(absDir);
        const spec = loadSkillEvalSpec(opts.spec, absDir);
        const { models, judgeSamples, budgetLimits } = resolveSpecOptions(
          opts,
          spec,
          command.getOptionValueSource("models") === "cli",
        );
        const database = openDb(opts.db);
        const skillName = skill.frontmatter.name;
        // Kernel cutover [9k5h.15]: the standard tier is open-world on optional
        // fields, so `version` is `unknown` — narrow before use.
        const skillVersion =
          typeof skill.frontmatter.version === "string" ? skill.frontmatter.version : "0.0.0";

        // OTel correlation inputs (iaj-E08, 067 §§ 1.1, 4.2). The skill
        // snapshot SHA is the content-addressed hash of the raw SKILL.md; the
        // spec content hash hashes the canonical JSON of the loaded eval spec.
        // Both are sha256:-prefixed per the platform digest convention.
        const skillSnapshotSha =
          "sha256:" + createHash("sha256").update(skillContent).digest("hex");
        const specContentHash =
          "sha256:" + createHash("sha256").update(JSON.stringify(spec)).digest("hex");

        if (!opts.json) {
          console.log(header(`j-rig eval: ${skillName}`));
          console.log(`  Models: ${models.join(", ")}\n`);
        }

        // ── Phase 2: Package Integrity ────────────────────────────────────
        const pkgReport = checkPackage(absDir);

        if (!opts.json) {
          console.log(header("--- Package Integrity ---"));
          const { summary } = pkgReport;
          console.log(`  ${summary.passed}/${summary.passed + summary.errors} checks passed`);
        }

        if (pkgReport.summary.errors > 0) {
          if (!opts.json) {
            printReport(pkgReport);
            console.error(chalk.red("\nPackage integrity failed. Fix errors before evaluation."));
          } else {
            console.log(JSON.stringify({ error: "Package integrity failed", pkgReport }, null, 2));
          }
          process.exit(1);
        }

        if (!opts.json) console.log("");

        // ── Phase 3: Per-model evaluation ────────────────────────────────
        const allResults: Record<string, unknown> = {};
        const retainedRollouts: RetainedRolloutRun[] = [];

        // Evidence Bundle accumulation (opt-in via --emit-bundle): one
        // gate-result/v1 in-toto Statement per model decision, paired with the
        // run id it belongs to. Written + linked as artifacts after the loop.
        const bundleRows: EvidenceStatement[] = [];
        const bundleRunIds: number[] = [];
        const jrigVersion = __CLI_VERSION__ ?? "0.0.0";
        const commit = resolveCommitSha(absDir, skillSnapshotSha);
        // `eval-batch` launches this command once per skill. Keep the batch
        // lineage on both the machine-readable result and every emitted
        // Evidence Bundle row so downstream reports can group without
        // guessing from filenames.
        const batchId = process.env.JRIG_BATCH_ID?.trim();
        const batchLineage = batchId
          ? {
              batch_id: batchId,
              ...(process.env.JRIG_BATCH_SKILL_RELATIVE_PATH?.trim()
                ? { batch_skill: process.env.JRIG_BATCH_SKILL_RELATIVE_PATH.trim() }
                : {}),
              ...(process.env.JRIG_BATCH_MANIFEST?.trim()
                ? { batch_manifest: process.env.JRIG_BATCH_MANIFEST.trim() }
                : {}),
            }
          : {};

        // ── Deterministic self-test (opt-in) ─────────────────────────────
        // Run the skill's declared `self_test.command` ONCE (it is
        // model-independent) and fold its verdict into every model's scorecard
        // as a `self-test` criterion. This closes the "script-backed skills
        // under-score" gap: a completion-only eval grades the model reading
        // SKILL.md, never the deterministic script that actually produces the
        // correct verdicts (design principle #3 — observed outranks claimed).
        const { selfTestJudgment, selfTestCriterion } = evaluateDeclaredSelfTest(
          spec.self_test,
          absDir,
          opts,
        );

        // Set when the infrastructure-failure override fires for ANY model:
        // that model was not (fully) evaluated, so the process must not exit 0
        // (a CI step that trusts the exit status would otherwise pass a
        // non-evaluation).
        let infrastructureFailureSeen = false;
        // One budget spans every model and phase of this invocation. The
        // wall clock starts here, after load and package integrity.
        const runBudget = new RunBudget(budgetLimits.limits, budgetLimits.sources);
        const costSession: GovernedCostSession | undefined = process.env.JRIG_COST_CONTEXT
          ? openCostSession(JSON.parse(process.env.JRIG_COST_CONTEXT))
          : undefined;
        if (costSession && claudeCodeSettings)
          throw new Error("Subscription execution cannot enforce native wire reservations");
        let budgetStopSeen = false;
        for (const model of models) {
          const modelStart = Date.now();
          const svId = getOrCreateSkillVersion(database, skillName, skillVersion, skillContent);
          const runId = createRun(database, svId, "full", model);
          transitionRun(database, runId, "running");

          // Select real vs stub providers ONCE per model so the trigger /
          // execution / judge layers all run against the same backend and the
          // same real `Provider` instance (one key, one transport). The
          // optional --provider flag forces a specific vendor;
          // --judge-provider/--judge-model decouple ONLY the judge leg. The
          // cost meter rides every real provider call and is phase-flipped at
          // each boundary below.
          const costMeter = new EvalCostMeter();
          runBudget.attach(costMeter, model);
          const providers = selectProviders(model, opts.provider, {
            meter: costMeter,
            costSession,
            ...(runBudget.active ? { budget: runBudget } : {}),
            executionReasoningEffort: executionParameters?.reasoning_effort,
            judgeProvider: opts.judgeProvider,
            judgeModel: opts.judgeModel,
            ...(claudeCodeSettings
              ? {
                  claudeCode: {
                    ...claudeCodeSettings,
                    skillDir: absDir,
                    skillName,
                  },
                }
              : {}),
          });

          // OTel: mint a UUIDv7 EvalRun id and emit runtime.run.started
          // (067 § 1.1). The DB integer runId stays the storage key; the
          // UUIDv7 is the cross-emitter idempotency key / lineage anchor.
          const correlation: EvalCorrelation = {
            evalRunId: uuidv7(),
            ...(costSession
              ? {
                  refinerAttemptId: costSession.context.attemptId,
                  refinerFileId: costSession.context.fileId,
                  refinerPolicyHash: hashRefinerValue(costSession.ledger.snapshot().policy),
                  costRecordScope: "evaluator-run" as const,
                }
              : {}),
          };
          emitRuntimeRunStarted(correlation, {
            specContentHash,
            skillSnapshotSha,
          });
          // Did any criterion or gate decision fail? Drives the terminal-state
          // enum on runtime.run.finished.
          let runHadFailure = false;

          // ── Budget stop (providers/budget.ts) ──────────────────────────
          // Called at a phase boundary once the guard has refused a call. The
          // evaluation is incomplete, so there is NO verdict and NO Evidence
          // Bundle row (an `error` row means a provider failed, which this is
          // not); the run is stored `failed` with the stop as its reason, and
          // the remaining models are not started.
          const costStop = (): BudgetStop | null => {
            if (!costSession?.refused) return null;
            const state = costSession.ledger.snapshot();
            const halt =
              state.lastHalt?.fileId === costSession.context.fileId &&
              (state.lastHalt.scope === "wave" || !state.stopped)
                ? state.lastHalt
                : undefined;
            const wave = halt ? halt.scope === "wave" : state.stopped;
            const spent = wave ? state.total : state.files[costSession.context.fileId]!;
            const tokens = halt?.reason.endsWith("tokens");
            const attempts = halt?.reason.endsWith("attempts");
            const max = tokens
              ? (wave ? state.policy.maxTotalTokens : state.policy.maxFileTokens)!
              : attempts
                ? (wave ? state.policy.maxAttempts : state.policy.maxFileAttempts)!
                : (wave ? costStopMicros(state.policy) : state.policy.maxFileMicros) / 1_000_000;
            return {
              limit: tokens ? "max_tokens" : attempts ? "max_calls" : "max_usd",
              max,
              observed: tokens
                ? spent.committedTokens
                : attempts
                  ? spent.calls
                  : spent.unknownCalls
                    ? null
                    : spent.committedMicros / 1_000_000,
              source: "cost-policy",
              phase: costSession.refused.phase,
              model,
              elapsed_ms: Date.now() - modelStart,
              reason: "Shared cost admission refused; inspect the pinned ledger",
            };
          };
          const stopForBudget = (stop: BudgetStop): void => {
            budgetStopSeen = true;
            transitionRun(
              database,
              runId,
              "failed",
              JSON.stringify({ type: "budget_exhausted", ...stop }),
            );
            allResults[model] = {
              ...executionMetadata,
              provider: providers.providerName,
              model,
              judge_provider: providers.judgeProviderName,
              judge_model: providers.judgeModelId,
              ground_truth: providers.real,
              pkgReport,
              budget_stop: stop,
              cost: providers.real || claudeCodeSettings ? costMeter.report() : null,
              ...batchLineage,
            };
            if (!opts.json) {
              console.log(
                `  ${icon("error")} Budget exhausted in the ${stop.phase} phase: ${stop.reason}. ` +
                  `Stopped with no verdict.`,
              );
            }
            emitRuntimeRunFinished(correlation, {
              terminalState: RuntimeTerminalState.ARCHIVED_FAILED,
              durationMs: Date.now() - modelStart,
            });
          };

          if (!opts.json) {
            console.log(header(`--- Model: ${model} ---`));
            console.log(
              `  Provider: ${
                providers.real
                  ? `${providers.providerName} (REAL — ground truth)`
                  : `${providers.providerName.toUpperCase()} (not ground truth)`
              }`,
            );
            if (providers.judgeProviderName !== providers.providerName) {
              console.log(
                `  Judge: ${providers.judgeProviderName} (${providers.judgeModelId}) — decoupled via --judge-provider`,
              );
            }
          }

          // ── Trigger tests ──────────────────────────────────────────────
          costMeter.phase = "trigger";
          let triggerResults: TriggerResult[] = [];
          if (opts.trigger !== false) {
            const roster = buildRoster(skill.frontmatter, spec.siblings);
            triggerResults = await runTriggerTests(spec.test_cases, roster, providers.trigger);
            const metrics = computeMetrics(triggerResults);

            if (!opts.json) {
              console.log(
                `  Trigger: precision=${metrics.precision.toFixed(2)} recall=${metrics.recall.toFixed(2)} (${metrics.total_cases} cases)`,
              );
            }
          }

          const triggerEvidence = storeTriggerEvidence(
            database,
            opts.db,
            runId,
            opts.trigger !== false,
            triggerResults,
          );
          const triggerFailure = detectInfrastructureFailure({
            triggers: triggerResults,
            outcomes: [],
            judgments: [],
            executionProvider: providers.providerName,
            judgeProvider: providers.judgeProviderName,
          });
          // A refused call keeps the budget-stop path. A provider failure with
          // unknown usage must still reach the signed infrastructure-error path.
          if (
            !costSession?.providerFailed &&
            (costSession?.refused || runBudget.stop || (!triggerFailure && runBudget.check()))
          ) {
            stopForBudget(costStop() ?? runBudget.stop!);
            break;
          }

          // Finalized after whichever phases run. This intentionally lives
          // outside the functional branch: trigger-only real-provider runs
          // spend tokens too and must emit the same cost.* run-end record.
          let costReport: EvalCostReport | null = null;

          // ── Functional tests + judgment ────────────────────────────────
          if (opts.functional !== false) {
            costMeter.phase = "execution";
            const outcomes: ObservedOutcome[] =
              (runBudget.active || costSession) && triggerFailure
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
              console.log(
                `  Functional: ${outcomes.length}/${spec.test_cases.length} test case(s) executed`,
              );
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
                  (opts.traceBoundary
                    ? ""
                    : " — re-run with --trace-boundary for per-case detail."),
              );
            }

            // Judge each outcome against the criteria that test case actually
            // exercises and flatten results. A test case may scope itself via
            // `criteria_ids` (schema default: ALL); honoring it stops an
            // off-topic criterion being judged against an unrelated control
            // prompt — the false-blocker bug that inflated NO-SHIP rates.
            const testCaseById = new Map(spec.test_cases.map((tc) => [tc.id, tc]));
            costMeter.phase = "judge";
            const { allJudgments, runHadFailure: judgmentFailed } = await evaluateOutcomeJudgments({
              outcomes,
              spec,
              testCaseById,
              providers,
              model,
              skillVersion,
              judgeSamples,
              correlation,
              runBudget,
              costSession,
              toolConfig,
            });
            if (judgmentFailed) runHadFailure = true;

            const skillFailure = detectInfrastructureFailure({
              triggers: triggerResults,
              outcomes,
              judgments: allJudgments,
              executionProvider: providers.providerName,
              judgeProvider: providers.judgeProviderName,
            });
            if (
              !costSession?.providerFailed &&
              (costSession?.refused || runBudget.stop || (!skillFailure && runBudget.check()))
            ) {
              stopForBudget(costStop() ?? runBudget.stop!);
              break;
            }

            // Fold the (model-independent) self-test verdict into THIS model's
            // judgments BEFORE the tally + persistence, so it counts in the
            // score line, the console output, the stored criterion_results, and
            // the run summary — consistent with the rollout decision it drives.
            if (selfTestJudgment) {
              allJudgments.push(selfTestJudgment);
              const stOutcome =
                selfTestJudgment.verdict === "yes" ? CriterionOutcome.PASS : CriterionOutcome.FAIL;
              if (stOutcome === CriterionOutcome.FAIL) runHadFailure = true;
              emitRuntimeCriterionEvaluated(correlation, {
                matcherClass: "deterministic",
                outcome: stOutcome,
              });
            }

            const passed = allJudgments.filter((j) => j.verdict === "yes").length;
            const total = allJudgments.length;

            if (!opts.json) {
              console.log(`  Judgment: ${formatScore(passed, total)}`);
              for (const j of allJudgments) {
                const verdictIcon =
                  j.verdict === "yes"
                    ? icon("pass")
                    : j.verdict === "unsure"
                      ? icon("warning")
                      : icon("error");
                console.log(`    ${verdictIcon} ${j.criterion_id}: ${j.reasoning.slice(0, 80)}`);
              }
            }

            // ── Evidence persistence ───────────────────────────────────
            const dbResults = allJudgments.map((j) => ({
              criterion_id: j.criterion_id,
              passed: j.verdict === "yes",
              severity: j.verdict === "yes" ? "pass" : j.verdict === "unsure" ? "warning" : "error",
              message: j.reasoning,
              method: j.method,
            }));
            storeCriterionResults(database, runId, dbResults);

            const errors = allJudgments.filter((j) => j.verdict === "no").length;
            const warnings = allJudgments.filter((j) => j.verdict === "unsure").length;
            storeRunSummary(database, runId, {
              total,
              passed,
              warnings,
              errors,
            });

            // ── Governance (score, layers 4 regression + 5 baseline, decision) ──
            const scoringCriteria = selfTestCriterion
              ? [...spec.criteria, selfTestCriterion]
              : spec.criteria;

            // Layer 5 — Baseline value (opt-in --baseline-check): re-run the same
            // test cases against the NAKED model (empty skill body = no skill
            // context) and compare. A skill that adds no value over the base model
            // is flagged obsolete_review. Doubles execution+judge cost (metered),
            // so it is opt-in; when off, the baseline layer is reported skipped.
            let baselineComparisons: BaselineComparison[] = [];
            let isObsolete = false;
            let ranBaseline = false;
            // Hoisted so a provider failure in the naked-baseline pass is held
            // to the same infrastructure-failure rule as the skill pass.
            let baselineOutcomes: ObservedOutcome[] = [];
            let baselineJudgments: JudgmentResult[] = [];
            if (opts.baselineCheck && (!(runBudget.active || costSession) || !skillFailure)) {
              ranBaseline = true;
              costMeter.phase = "execution";
              const nakedOutcomes = await runFunctionalTests(
                spec.test_cases,
                { ...skill, body: "" },
                providers.execution,
                {
                  model,
                  temperature: spec.execution_temperature ?? 0,
                  ...(toolConfig ? { tool_runtime: toolConfig.runtime } : {}),
                },
              );
              costMeter.phase = "judge";
              const nakedJudgments: JudgmentResult[] = [];
              baselineOutcomes = nakedOutcomes;
              if (toolConfig) {
                toolReceipts.push(
                  storeToolExecutionEvidence(
                    database,
                    opts.db,
                    runId,
                    "baseline",
                    toolConfig.fingerprint,
                    nakedOutcomes,
                    !!toolConfig.runtime.judgeObservations,
                    toolConfig.runtime.limits.maxTotalBytes,
                    executionParameters,
                  ),
                );
              }
              baselineJudgments = nakedJudgments;
              const baselineExecutionFailed = nakedOutcomes.some(isFailedExecution);
              for (const outcome of nakedOutcomes) {
                if (runBudget.active && baselineExecutionFailed) break;
                if (isFailedExecution(outcome)) continue;
                const testCase = testCaseById.get(outcome.test_case_id);
                if (!testCase) continue;
                const nakedCriteria = selectCriteriaForTestCase(
                  spec.criteria,
                  testCase.criteria_ids,
                );
                const judgments = await judgeCriteria(nakedCriteria, outcome, providers.judge, {
                  ...(toolConfig?.runtime.judgeObservations
                    ? {
                        observations: getJudgeObservations(
                          outcome,
                          true,
                          toolConfig.runtime.limits.maxTotalBytes,
                        ),
                      }
                    : {}),
                  model: providers.judgeModelId,
                  samples: judgeSamples,
                  judgeTemperature: spec.judge_temperature,
                  judgeTimeoutMs: spec.judge_timeout_ms,
                  sampleConcurrency: spec.judge_sample_concurrency,
                });
                nakedJudgments.push(
                  ...judgments.map((j) => ({ ...j, test_case_id: outcome.test_case_id })),
                );
              }
              baselineComparisons = compareBaseline(allJudgments, nakedJudgments);
              isObsolete = isObsoleteCandidate(baselineComparisons);
              if (!opts.json) {
                const adds = baselineComparisons.filter((c) => c.skill_adds_value).length;
                console.log(
                  `  Baseline: skill adds value on ${adds}/${baselineComparisons.length} criteria` +
                    (isObsolete
                      ? " — FLAGGED obsolete_review (little value over the naked model)"
                      : ""),
                );
              }
            }
            // The naked-baseline pass spends too; a stop there leaves the
            // skill pass's criterion results stored but the run unverdicted.
            const evaluationFailure = detectInfrastructureFailure({
              triggers: triggerResults,
              outcomes: [...outcomes, ...baselineOutcomes],
              judgments: [...allJudgments, ...baselineJudgments],
              executionProvider: providers.providerName,
              judgeProvider: providers.judgeProviderName,
            });
            if (
              !costSession?.providerFailed &&
              (costSession?.refused || runBudget.stop || (!evaluationFailure && runBudget.check()))
            ) {
              stopForBudget(costStop() ?? runBudget.stop!);
              break;
            }

            // Layer 4 — Regression protection (opt-in --regression-baseline <path>):
            // compare this run against a prior run's judgments. A criterion that
            // passed before and now fails is a regression; a SACRED regression
            // (criterion.regression_critical) BLOCKS regardless of average gain —
            // computeScoreCard folds sacred_regressions into the decision. Without
            // a baseline the layer is honestly skipped (reported below).
            let regressions: Regression[] = [];
            let ranRegression = false;
            let regressionBaselineSha256: string | null = null;
            if (opts.regressionBaseline) {
              ranRegression = true;
              const previousJudgments = loadRegressionBaseline(opts.regressionBaseline);
              regressionBaselineSha256 =
                "sha256:" +
                createHash("sha256").update(readFileSync(opts.regressionBaseline)).digest("hex");
              regressions = detectRegressions(previousJudgments, allJudgments, scoringCriteria);
              if (!opts.json) {
                const sacred = regressions.filter((r) => r.is_sacred).length;
                console.log(
                  `  Regression: ${regressions.length} regression(s) vs baseline` +
                    (sacred > 0 ? ` — ${sacred} SACRED (BLOCKS)` : ""),
                );
              }
            }

            const scoreCard = computeScoreCard(allJudgments, scoringCriteria, regressions, {
              // Stability gate: a multi-sampled blocker "no" below this
              // agreement fraction downgrades to a warning — a verdict too
              // unstable to reproduce is too unstable to BLOCK (or sign) on.
              min_blocker_agreement: spec.min_blocker_agreement,
            });
            const decision = decideRollout(scoreCard, isObsolete);
            const report = buildLaunchReport(
              skillName,
              scoreCard,
              regressions,
              baselineComparisons,
              isObsolete,
              // DR-103 D5 B5.1: inject `now` so the launch-report artifact is
              // replayable (the determinism the adoption signal's bandit-rejection
              // rests on). One timestamp per model run.
              { now: new Date(modelStart).toISOString() },
            );

            // The legacy skill evaluator predates the generic Run/Grade
            // substrate, so make its effective grader explicit and immutable
            // in the promotion metadata. The snapshot covers every criterion
            // plus the judge/stability settings that influence the fold.
            const graderSnapshot = {
              schema: "j-rig/binary-criteria-grader/v1",
              ...executionMetadata,
              ...(toolConfig?.runtime.judgeObservations
                ? {
                    tool_observations: "jrig-tool-observations/v1",
                    mcp_configuration_sha256: toolConfig.fingerprint,
                  }
                : {}),
              criteria: scoringCriteria,
              judge: {
                provider: providers.judgeProviderName,
                model: providers.judgeModelId,
                samples: judgeSamples ?? 1,
                temperature: spec.judge_temperature ?? 0,
                timeout_ms: spec.judge_timeout_ms ?? 120000,
                sample_concurrency: spec.judge_sample_concurrency ?? judgeSamples ?? 1,
              },
              stability: {
                min_blocker_agreement: spec.min_blocker_agreement ?? null,
              },
            };
            const promotionEvidence = buildSkillPromotionEvidence({
              evalRunId: correlation.evalRunId,
              storageRunId: runId,
              skill: {
                name: skillName,
                version: skillVersion,
                snapshotSha256: skillSnapshotSha,
              },
              evalSpec: {
                id: `j-rig:skill-profile:${sanitizeSegment(skillName, "skill")}`,
                version: spec.spec_version,
                profileSha256: specContentHash,
              },
              selectedGrader: {
                graderId: "j-rig-binary-criteria",
                graderVersion: jrigVersion,
                graderSnapshotSha256: hashCanonicalJson(graderSnapshot),
              },
              score: scoreCard,
              minBlockerAgreement: spec.min_blocker_agreement ?? null,
              regressions,
              regressionEnabled: ranRegression,
              regressionBaselineSha256,
              baselineEnabled: ranBaseline,
              baselineComparisons,
              isObsolete,
              rolloutDecision: report.decision,
            });
            // ── Eval cost (Jeremy's ask: "what does it cost to eval this
            // skill, as-is?") — real token usage per phase, × N judge samples,
            // with a best-effort USD estimate. Stub runs record nothing.
            costReport = providers.real || claudeCodeSettings ? costMeter.report() : null;

            // ── Infrastructure-failure rule (000-docs/037) ─────────────
            // Blueprint B § 7.4: `error` is "a verdict on the gate's own
            // ability to evaluate". ANY unrecovered provider failure — a test
            // case that never executed, or a criterion whose every judge sample
            // errored, in the skill or the naked-baseline pass — means the
            // scorecard below was computed over an incomplete evaluation. It is
            // kept for diagnosis but is not a verdict on the skill: the row is
            // signed `error`, the run is stored `failed`, the exit is non-zero.
            // This generalizes the 2026-09 dead-judge override (conference
            // audit, "make it lie" #E), which fired only when EVERY judgment
            // died and ignored execution failures entirely.
            const infraFailure = evaluationFailure;
            const infraFailureReason = infraFailure
              ? infrastructureFailureReason(infraFailure)
              : null;

            // ── Headroom (000-docs/043) ────────────────────────────────
            // Can this eval still show that a change helped? A measurement of
            // the eval, not the skill: it rides beside the decision and never
            // changes it. An infrastructure failure has no verdict, so it gets
            // no headroom claim either.
            const headroom = infraFailure
              ? null
              : assessHeadroom({
                  passed: scoreCard.passed,
                  trials: scoreCard.total_criteria,
                  ceiling: spec.headroom_ceiling,
                });
            if (headroom) {
              report.headroom = headroom;
              if (!opts.json && headroom.status !== "headroom") {
                console.log(`  ${icon("warning")} ${formatHeadroom(headroom)}`);
              }
            }

            allResults[model] = {
              ...executionMetadata,
              provider: providers.providerName,
              model,
              judge_provider: providers.judgeProviderName,
              judge_model: providers.judgeModelId,
              ground_truth: providers.real,
              pkgReport,
              trigger: triggerEvidence,
              // The observed tool-call order + produced-file manifest per case
              // (claude-code execution only): the record the trajectory checks
              // graded, kept so a reader can re-check a verdict.
              ...(claudeCodeSettings
                ? {
                    trajectories: outcomes.map((o) => ({
                      test_case_id: o.test_case_id,
                      status: o.status,
                      ...(o.output.error ? { error: o.output.error } : {}),
                      input_tokens: o.meta.input_tokens ?? null,
                      output_tokens: o.meta.output_tokens ?? null,
                      // Claude Code's own API-equivalent figure; on the
                      // subscription this is not a bill.
                      cost_usd_api_equivalent: o.meta.estimated_cost_usd ?? null,
                      ...(o.output.trajectory ? { trajectory: o.output.trajectory } : {}),
                    })),
                  }
                : {}),
              scoreCard,
              // Exact per-case verdicts for downstream frozen-input scoring.
              // Deliberately omit model text and judge explanations.
              criterion_results: allJudgments.map((judgment) => ({
                criterion_id: judgment.criterion_id,
                test_case_id: judgment.test_case_id,
                verdict: judgment.verdict,
              })),
              decision,
              report,
              // Exactly one of these is present. An incomplete evaluation
              // carries `evaluation_error` and NO promotion evidence: a
              // promotion claim over criteria that were never evaluated would
              // be meaningless, and its own pass|fail|advisory field would
              // contradict the `error` verdict.
              ...(infraFailure
                ? { gate_decision: "error", evaluation_error: infraFailure }
                : { promotion: promotionEvidence }),
              cost: costReport,
              ...batchLineage,
            };

            // OTel gate.decision.emitted (067 § 2.2). Map the j-rig
            // RolloutDecision plus promotion evidence onto the closed
            // gate-result/v1 verdict enum {pass,fail,advisory,error}. A `ship`
            // decision without the required regression comparison is advisory
            // until the evidence is complete; this prevents a skipped layer
            // from becoming a false promotion pass. Spelling is identical to
            // the audit-harness iah-E07 emitter so a ship-gate dashboard alerts
            // on one event name across both emitters.
            //
            // Infrastructure failure wins over every other mapping, promotion
            // included: the kernel enum has `error` for exactly this, and
            // gate_reasons[0] must name the error class (computed above).
            const gateDecisionValue = infraFailure
              ? GateDecision.ERROR
              : promotionEvidence.gate_decision === "pass"
                ? GateDecision.PASS
                : promotionEvidence.gate_decision === "fail"
                  ? GateDecision.FAIL
                  : GateDecision.ADVISORY;
            if (
              gateDecisionValue === GateDecision.FAIL ||
              gateDecisionValue === GateDecision.ERROR
            ) {
              runHadFailure = true;
            }
            if (infraFailure) infrastructureFailureSeen = true;
            if (infraFailureReason && !opts.json) {
              console.log(`  ${icon("error")} ${infraFailureReason}`);
            }
            emitGateDecisionEmitted(correlation, {
              gateName: "j-rig-rollout-gate",
              decision: gateDecisionValue,
              policyRef: specContentHash,
            });

            // ── Evidence Bundle row (opt-in via --emit-bundle) ─────────
            // Compose a real, kernel-validated gate-result/v1 in-toto Statement
            // from this model's rollout decision. composeStatement fail-closes
            // (throws) on any invalid field, so a successfully written bundle is
            // proof-by-construction that every row is kernel-valid and directly
            // consumable by intent-rollout-gate. Reuses the same
            // promotion evidence → pass|fail|advisory mapping as the OTel emit.
            if (opts.emitBundle) {
              const gateDecision = infraFailure ? "error" : promotionEvidence.gate_decision;
              const gateReasons = [
                ...new Set([
                  ...report.blockers,
                  ...report.warnings,
                  // Promotion reasons describe a verdict; an `error` row has none.
                  ...(infraFailure ? [] : promotionEvidence.promotion_reasons),
                ]),
              ];
              if (infraFailureReason) gateReasons.unshift(infraFailureReason);
              if (gateReasons.length === 0) {
                gateReasons.push(report.reasoning || "all criteria met");
              }
              const triggerRan = triggerEvidence.status === "complete";
              // Vote evidence (audit-substrate review, finding 1): the signed
              // predicate must carry the FOLD INPUTS — per-judgment samples,
              // agreement, and per-sample verdicts — plus the aggregation rule
              // in force, so a verifier can re-derive the verdict from the
              // signed bytes ("majority of these N recorded votes", never
              // "the judge said so"). `stability` is present IFF multi-
              // sampling actually ran, so absence unambiguously means "no
              // stability evidence" — never a fake measured-0.
              const voteEvidence = buildVoteEvidence({
                allJudgments,
                scoringCriteria,
                spec,
                judgeSamples,
                scoreCard,
              });
              const hasJudgeCriteria = allJudgments.some((j) => j.method === "judge");
              const statement = composeStatement({
                gateId: `j-rig:local:${sanitizeSegment(skillName, "skill")}.${sanitizeSegment(model, "model")}`,
                gateDecision,
                gateName: "rollout",
                gateVersion: jrigVersion,
                gateReasons,
                coverage: {
                  dimensionsEvaluated: [
                    ...(triggerRan ? ["trigger"] : []),
                    "functional",
                    "behavioral",
                    ...(ranRegression ? ["regression"] : []),
                    ...(ranBaseline ? ["baseline"] : []),
                  ],
                  dimensionsSkipped: [
                    ...(triggerRan ? [] : ["trigger"]),
                    ...(ranRegression ? [] : ["regression"]),
                    ...(ranBaseline ? [] : ["baseline"]),
                  ],
                },
                policyRef: `${specContentHash}:eval-spec.yaml`,
                policyHash: specContentHash,
                inputHash: skillSnapshotSha,
                evaluatedAt: new Date(modelStart).toISOString(),
                runner: `j-rig@${jrigVersion}`,
                commitSha: commit.sha,
                metadata: {
                  ...executionMetadata,
                  trigger: triggerEvidence,
                  model,
                  provider: providers.providerName,
                  ground_truth: providers.real,
                  ...(toolConfig
                    ? {
                        tool_execution: {
                          transport: "mcp-stdio",
                          configuration_sha256: toolConfig.fingerprint,
                          session_scope: "fresh_process_per_case",
                          baseline_same_capabilities: true,
                          receipts: toolReceipts,
                        },
                      }
                    : {}),
                  pass_rate: scoreCard.pass_rate,
                  passed: scoreCard.passed,
                  total_criteria: scoreCard.total_criteria,
                  commit_sha_source: commit.source,
                  // Blueprint B § 7.4 SHOULD: structured detail for `error`.
                  // Mutually exclusive with promotion evidence (see above).
                  ...(infraFailure ? { error_detail: infraFailure } : promotionEvidence),
                  ...(headroom ? { headroom } : {}),
                  ...batchLineage,
                  ...voteEvidence,
                },
                // Honest replay-fidelity claim: an un-seeded API judge caps the
                // statement below RF-2 (the OTel llm_no_seed classification) —
                // the fold is replayable from the recorded votes above, the
                // votes are not reproducible from scratch. Pure-deterministic
                // runs make no claim rather than guessing a higher level.
                ...(hasJudgeCriteria ? { replayFidelityLevel: "RF-1" as const } : {}),
                ...(gateDecision === "fail"
                  ? {
                      failureMode:
                        report.blockers[0] ??
                        promotionEvidence.promotion_reasons.at(-1) ??
                        "promotion-evidence-failed",
                    }
                  : {}),
                ...(gateDecision === "advisory" ? { advisorySeverity: "warn" as const } : {}),
              });
              bundleRows.push(statement);
              bundleRunIds.push(runId);
            }

            if (!opts.json) {
              console.log(`  Decision: ${formatDecision(report.decision)}`);
              if (report.blockers.length > 0) {
                for (const b of report.blockers) {
                  console.log(`    ${icon("error")} ${b}`);
                }
              }
              if (report.warnings.length > 0) {
                for (const w of report.warnings) {
                  console.log(`    ${icon("warning")} ${w}`);
                }
              }
              console.log("");
            }

            if (opts.rolloutFile) {
              retainedRollouts.push(
                retainRolloutRun(
                  {
                    runId,
                    model,
                    provider: claudeCodeSettings
                      ? CLAUDE_CODE_PROVIDER_NAME
                      : providers.providerName,
                    groundTruth: providers.real,
                    status: infraFailure ? "failed" : "completed",
                  },
                  outcomes,
                ),
              );
            }

            if (infraFailure) {
              transitionRun(database, runId, "failed", JSON.stringify(infraFailure));
            } else {
              transitionRun(database, runId, "completed");
            }
          } else {
            if (triggerFailure) {
              infrastructureFailureSeen = true;
              runHadFailure = true;
              transitionRun(database, runId, "failed", JSON.stringify(triggerFailure));
            } else {
              transitionRun(database, runId, "completed");
            }
          }

          // ── Eval cost (all executed phase combinations) ───────────────
          // A --no-functional run used to skip this whole block because cost
          // reporting lived inside the functional branch. Snapshot the meter
          // here after trigger/execution/judge work has settled, then print and
          // emit one consistent run-end record for both full and trigger-only
          // real-provider evals. Stub runs remain honestly unmetered.
          // claude-code execution is a real run even when the judge is a stub.
          costReport ??= providers.real || claudeCodeSettings ? costMeter.report() : null;
          reportEvalCost(costReport, opts, correlation, judgeSamples);

          // Full runs populate the richer result in the functional branch.
          // Trigger-only runs still need a machine-readable cost/provenance row.
          if (!(model in allResults)) {
            allResults[model] = {
              provider: providers.providerName,
              model,
              judge_provider: providers.judgeProviderName,
              judge_model: providers.judgeModelId,
              ground_truth: providers.real,
              pkgReport,
              functional_skipped: true,
              trigger: triggerEvidence,
              ...(triggerFailure
                ? { gate_decision: "error", evaluation_error: triggerFailure }
                : {}),
              cost: costReport,
              ...batchLineage,
            };
          }

          // OTel runtime.run.finished (067 § 1.1). Terminal state per the
          // EvalRun state machine: a run that produced a failing criterion or a
          // FAIL gate decision is archived_failed; an all-pass run is judged.
          // (archived_success is reserved for the runtime's post-judgment
          // archival lifecycle, which the CLI path does not drive.)
          emitRuntimeRunFinished(correlation, {
            terminalState: runHadFailure
              ? RuntimeTerminalState.ARCHIVED_FAILED
              : RuntimeTerminalState.JUDGED,
            durationMs: Date.now() - modelStart,
          });
        }

        finalizeEvaluation({
          models,
          allResults,
          budgetStopSeen,
          runBudget,
          opts,
          bundleRows,
          bundleRunIds,
          database,
          absDir,
          skillSnapshotSha,
          spec,
          infrastructureFailureSeen,
          retainedRollouts,
          startTime,
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
