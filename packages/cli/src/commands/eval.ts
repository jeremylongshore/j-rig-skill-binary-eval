import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  checkPackage,
  buildRoster,
  runTriggerTests,
  computeMetrics,
  runFunctionalTests,
  judgeCriteria,
  computeScoreCard,
  decideRollout,
  buildLaunchReport,
  uuidv7,
  emitRuntimeRunStarted,
  emitRuntimeRunFinished,
  emitRuntimeCriterionEvaluated,
  emitJudgeInvoked,
  emitJudgeVerdict,
  emitGateDecisionEmitted,
  RuntimeTerminalState,
  CriterionOutcome,
  JudgeVerdictSource,
  GateDecision,
  type EvalCorrelation,
} from "@j-rig/core";
import type { JudgmentResult, ObservedOutcome } from "@j-rig/core";
import {
  getOrCreateSkillVersion,
  createRun,
  transitionRun,
  storeCriterionResults,
  storeRunSummary,
} from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { loadEvalSpec, loadSkillMd } from "../lib/loaders.js";
import {
  printReport,
  header,
  formatDecision,
  formatScore,
  formatDuration,
  icon,
} from "../lib/output.js";
import {
  StubTriggerProvider,
  StubExecutionProvider,
  StubJudgeProvider,
  assertStubAllowed,
} from "../providers/anthropic.js";
import {
  RealAnthropicProvider,
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
import type { TriggerProvider, ExecutionProvider, JudgeProvider } from "@j-rig/core";

interface EvalOptions {
  spec?: string;
  models: string;
  db: string;
  json?: boolean;
  trigger?: boolean;
  functional?: boolean;
  provider?: string;
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
}

/**
 * Select real vs stub providers for a model.
 *
 * Provider precedence (output IS ground truth on any real path):
 *   1. An OpenAI-compatible endpoint — DeepSeek, Kimi/Moonshot, OpenRouter, or a
 *      generic `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` triple. A `--provider`
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
function selectProviders(model: string, preferred?: string): SelectedProviders {
  const want = preferred?.trim().toLowerCase();

  // Explicit stub request — let the stub constructors enforce the opt-in gate.
  if (want === "stub") {
    return {
      trigger: new StubTriggerProvider(model),
      execution: new StubExecutionProvider(model),
      judge: new StubJudgeProvider(model),
      real: false,
      providerName: "stub",
    };
  }

  // 1. OpenAI-compatible path (DeepSeek / Kimi / OpenRouter / generic LLM_*).
  // Skipped only when the operator explicitly asked for `anthropic`.
  if (want !== "anthropic") {
    const cfg = resolveOpenAICompatConfig(process.env, want);
    if (cfg) {
      // The --models target (haiku/sonnet/opus) is an Anthropic-only label and is
      // NOT a valid vendor model id on the OpenAI-compatible path — sending it to
      // Groq/DeepSeek 404s. Use the configured vendor model (LLM_MODEL / preset
      // defaultModel); fall back to the target only if no vendor model is set.
      const effectiveModel =
        cfg.defaultModel && cfg.defaultModel.length > 0 ? cfg.defaultModel : model;
      const provider = new RealOpenAICompatProvider({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        name: cfg.name,
      });
      return {
        trigger: new OpenAICompatTriggerProvider(effectiveModel, provider),
        execution: new OpenAICompatExecutionProvider(effectiveModel, provider),
        judge: new OpenAICompatJudgeProvider(effectiveModel, provider),
        real: true,
        providerName: cfg.name,
      };
    }
  }

  // 2. Real Anthropic path.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.length >= 8) {
    const provider = new RealAnthropicProvider({ apiKey });
    return {
      trigger: new AnthropicTriggerProvider(model, provider),
      execution: new AnthropicExecutionProvider(model, provider),
      judge: new AnthropicJudgeProvider(model, provider),
      real: true,
      providerName: "anthropic",
    };
  }

  // 3. No real key — stub providers (each constructor re-asserts the opt-in gate).
  return {
    trigger: new StubTriggerProvider(model),
    execution: new StubExecutionProvider(model),
    judge: new StubJudgeProvider(model),
    real: false,
    providerName: "stub",
  };
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
 * Orchestrates all 7 evaluation layers for a skill:
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
export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description("Run full 7-layer binary evaluation on a skill")
    .argument("<skill-dir>", "Path to skill directory containing SKILL.md")
    .option("--spec <path>", "Path to eval spec YAML")
    .option("--models <list>", "Comma-separated model list", "sonnet")
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--json", "Output as JSON")
    .option("--no-trigger", "Skip trigger tests")
    .option("--no-functional", "Skip functional tests")
    .option(
      "--provider <name>",
      "Force a provider: deepseek | kimi | moonshot | openrouter | anthropic | stub " +
        "(default: auto-detect from env keys, preferring an OpenAI-compatible endpoint)",
    )
    .action(async (skillDir: string, opts: EvalOptions) => {
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
        const hasRealKey = hasAnyRealKey(opts.provider);
        if (!hasRealKey) assertStubAllowed();

        // ── Phase 1: Load ────────────────────────────────────────────────
        const absDir = resolve(skillDir);
        const { parsed: skill, raw: skillContent } = loadSkillMd(absDir);
        const spec = loadEvalSpec(opts.spec, absDir);
        const models = opts.models.split(",").map((m) => m.trim());
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

        for (const model of models) {
          const modelStart = Date.now();
          const svId = getOrCreateSkillVersion(database, skillName, skillVersion, skillContent);
          const runId = createRun(database, svId, "full", model);
          transitionRun(database, runId, "running");

          // Select real vs stub providers ONCE per model so the trigger /
          // execution / judge layers all run against the same backend and the
          // same real `Provider` instance (one key, one transport). The
          // optional --provider flag forces a specific vendor.
          const providers = selectProviders(model, opts.provider);

          // OTel: mint a UUIDv7 EvalRun id and emit runtime.run.started
          // (067 § 1.1). The DB integer runId stays the storage key; the
          // UUIDv7 is the cross-emitter idempotency key / lineage anchor.
          const correlation: EvalCorrelation = { evalRunId: uuidv7() };
          emitRuntimeRunStarted(correlation, {
            specContentHash,
            skillSnapshotSha,
          });
          // Did any criterion or gate decision fail? Drives the terminal-state
          // enum on runtime.run.finished.
          let runHadFailure = false;

          if (!opts.json) {
            console.log(header(`--- Model: ${model} ---`));
            console.log(
              `  Provider: ${
                providers.real
                  ? `${providers.providerName} (REAL — ground truth)`
                  : `${providers.providerName.toUpperCase()} (not ground truth)`
              }`,
            );
          }

          // ── Trigger tests ──────────────────────────────────────────────
          if (opts.trigger !== false) {
            const roster = buildRoster(skill.frontmatter, spec.siblings);
            const triggerResults = await runTriggerTests(
              spec.test_cases,
              roster,
              providers.trigger,
            );
            const metrics = computeMetrics(triggerResults);

            if (!opts.json) {
              console.log(
                `  Trigger: precision=${metrics.precision.toFixed(2)} recall=${metrics.recall.toFixed(2)} (${metrics.total_cases} cases)`,
              );
            }
          }

          // ── Functional tests + judgment ────────────────────────────────
          if (opts.functional !== false) {
            const outcomes: ObservedOutcome[] = await runFunctionalTests(
              spec.test_cases,
              skill,
              providers.execution,
              { model },
            );

            if (!opts.json) {
              console.log(
                `  Functional: ${outcomes.length}/${spec.test_cases.length} test case(s) executed`,
              );
            }

            // Judge each outcome against all criteria and flatten results.
            const allJudgments: JudgmentResult[] = [];

            for (const outcome of outcomes) {
              const judgments = await judgeCriteria(spec.criteria, outcome, providers.judge, {
                model,
              });

              // OTel per-criterion events (067 §§ 1.1, 1.2). For judge-method
              // criteria we emit judge.invoked + judge.verdict; for every
              // criterion we emit runtime.criterion.evaluated with the binary
              // outcome mapped to the closed {pass,fail,skip} enum.
              for (const j of judgments) {
                if (j.method === "judge") {
                  emitJudgeInvoked(correlation, {
                    judgeId: `j-rig:judge:${j.criterion_id}`,
                    modelId: j.judge_model ?? model,
                    modelVersion: skillVersion,
                  });
                  // A judge with no seed cannot reach RF-2 (066 § 1); j-rig
                  // judges run un-seeded today, so verdict_source is
                  // llm_no_seed and the seed attribute is null (omitted).
                  emitJudgeVerdict(correlation, {
                    verdict: j.verdict,
                    verdictSource: JudgeVerdictSource.LLM_NO_SEED,
                    seed: null,
                  });
                }
                const criterionOutcome =
                  j.verdict === "yes"
                    ? CriterionOutcome.PASS
                    : j.verdict === "unsure"
                      ? CriterionOutcome.SKIP
                      : CriterionOutcome.FAIL;
                if (criterionOutcome === CriterionOutcome.FAIL) runHadFailure = true;
                emitRuntimeCriterionEvaluated(correlation, {
                  matcherClass: j.method,
                  outcome: criterionOutcome,
                });
              }

              allJudgments.push(...judgments);
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

            // ── Governance ─────────────────────────────────────────────
            const scoreCard = computeScoreCard(allJudgments, spec.criteria);
            const decision = decideRollout(scoreCard);
            const report = buildLaunchReport(
              skillName,
              scoreCard,
              [], // regressions: none in a standalone run
              [], // baseline: none without a baseline comparison run
              false, // isObsolete: not computed here
            );

            allResults[model] = {
              provider: providers.providerName,
              model,
              ground_truth: providers.real,
              pkgReport,
              scoreCard,
              decision,
              report,
            };

            // OTel gate.decision.emitted (067 § 2.2). Map the j-rig
            // RolloutDecision (ship|warn|block|obsolete_review) onto the closed
            // gate-result/v1 verdict enum {pass,fail,advisory,error}: a clean
            // ship is `pass`, a block is `fail`, warn/obsolete_review are
            // `advisory`. Spelling is identical to the audit-harness iah-E07
            // emitter so a ship-gate dashboard alerts on one event name across
            // both emitters.
            const gateDecisionValue =
              report.decision === "ship"
                ? GateDecision.PASS
                : report.decision === "block"
                  ? GateDecision.FAIL
                  : GateDecision.ADVISORY;
            if (gateDecisionValue === GateDecision.FAIL) runHadFailure = true;
            emitGateDecisionEmitted(correlation, {
              gateName: "j-rig-rollout-gate",
              decision: gateDecisionValue,
              policyRef: specContentHash,
            });

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

            transitionRun(database, runId, "completed");
          } else {
            transitionRun(database, runId, "completed");
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

        // ── Phase 4: Final output ─────────────────────────────────────────
        const duration = Date.now() - startTime;

        if (opts.json) {
          console.log(JSON.stringify(allResults, null, 2));
        } else {
          console.log(chalk.dim(`Duration: ${formatDuration(duration)} | DB: ${opts.db}`));
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
