import { evaluateDeclaredSelfTest } from "./eval-self-test.js";

import {
  positiveNumber,
  resolveExecutionParameters,
  resolveSpecOptions,
} from "./eval-preflight.js";

import { hashValue as hashRefinerValue } from "@intentsolutions/refiner-core";
import {
  createCostTransport,
  CostAdmissionError,
  openCostSession,
  type CostSession,
} from "@intentsolutions/refiner";
import { createFetchTransport } from "../providers/transport.js";
import type { RetainedRolloutRun } from "./rollout-export.js";
import type { ReasoningEffort } from "@j-rig/core";

import { loadMcpRuntime } from "../execution/mcp-runtime.js";
import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  checkPackage,
  uuidv7,
  ProviderError,
  emitRuntimeRunStarted,
  type EvalCorrelation,
} from "@j-rig/core";
import type { EvidenceStatement } from "@j-rig/core";
import { getOrCreateSkillVersion, createRun, transitionRun } from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { loadSkillEvalSpec, loadSkillMd } from "../lib/loaders.js";
import { printReport, header } from "../lib/output.js";
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

import { CostTrackingProvider, EvalCostMeter } from "../providers/cost-tracking.js";
import {
  BudgetGuardedExecutionProvider,
  BudgetGuardedProvider,
  RunBudget,
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

/** Prepare invocation-owned resources once, before any model starts. */
export async function prepareEvaluationInvocation(
  skillDir: string,
  opts: EvalOptions,
  command: Command,
) {
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
  if (opts.mcpConfig && (!hasRealKey || opts.provider === "stub" || opts.functional === false)) {
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
  const skillSnapshotSha = "sha256:" + createHash("sha256").update(skillContent).digest("hex");
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

  // One budget spans every model and phase of this invocation. The
  // wall clock starts here, after load and package integrity.
  const runBudget = new RunBudget(budgetLimits.limits, budgetLimits.sources);
  const costSession: GovernedCostSession | undefined = process.env.JRIG_COST_CONTEXT
    ? openCostSession(JSON.parse(process.env.JRIG_COST_CONTEXT))
    : undefined;
  if (costSession && claudeCodeSettings)
    throw new Error("Subscription execution cannot enforce native wire reservations");
  return {
    opts,
    executionParameters,
    executionMetadata,
    claudeCodeSettings,
    toolConfig,
    absDir,
    skill,
    skillContent,
    spec,
    models,
    judgeSamples,
    database,
    skillName,
    skillVersion,
    skillSnapshotSha,
    specContentHash,
    pkgReport,
    allResults,
    retainedRollouts,
    bundleRows,
    bundleRunIds,
    jrigVersion,
    commit,
    batchLineage,
    selfTestJudgment,
    selfTestCriterion,
    runBudget,
    costSession,
  };
}

export type EvaluationInvocation = Awaited<ReturnType<typeof prepareEvaluationInvocation>>;
/** Open storage and provider/correlation state before evaluating a model. */
export function startEvaluationModel(context: EvaluationInvocation, model: string) {
  const {
    database,
    skillName,
    skillVersion,
    skillContent,
    runBudget,
    opts,
    costSession,
    executionParameters,
    claudeCodeSettings,
    absDir,
    specContentHash,
    skillSnapshotSha,
  } = context;
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
  return { modelStart, runId, costMeter, providers, correlation };
}
