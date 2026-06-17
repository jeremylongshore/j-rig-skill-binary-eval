import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
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
import type { TriggerProvider, ExecutionProvider, JudgeProvider } from "@j-rig/core";

interface EvalOptions {
  spec?: string;
  models: string;
  db: string;
  json?: boolean;
  trigger?: boolean;
  functional?: boolean;
}

/** The three eval-pipeline providers a single run needs, plus whether real. */
interface SelectedProviders {
  trigger: TriggerProvider;
  execution: ExecutionProvider;
  judge: JudgeProvider;
  /** true = real Anthropic API; false = stub (NOT ground truth). */
  real: boolean;
}

/**
 * Select real vs stub providers for a model.
 *
 * Real path: when `ANTHROPIC_API_KEY` is set, build a real Anthropic
 * `Provider` and bridge it into the three eval-pipeline interfaces. This is the
 * iaj-E10 behavioral dogfood path — output IS ground truth.
 *
 * Stub path: when no key is set, fall back to stubs — but only if the operator
 * explicitly opted in via `J_RIG_ALLOW_STUB=1`. Without the key AND without the
 * opt-in, `assertStubAllowed()` throws REFUSED (synthetic ship verdicts are too
 * costly to emit silently).
 */
function selectProviders(model: string): SelectedProviders {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.length >= 8) {
    const provider = new RealAnthropicProvider({ apiKey });
    return {
      trigger: new AnthropicTriggerProvider(model, provider),
      execution: new AnthropicExecutionProvider(model, provider),
      judge: new AnthropicJudgeProvider(model, provider),
      real: true,
    };
  }
  // No real key — stub providers (each constructor re-asserts the opt-in gate).
  return {
    trigger: new StubTriggerProvider(model),
    execution: new StubExecutionProvider(model),
    judge: new StubJudgeProvider(model),
    real: false,
  };
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
        const hasRealKey = (process.env.ANTHROPIC_API_KEY?.length ?? 0) >= 8;
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
          const svId = getOrCreateSkillVersion(database, skillName, skillVersion, skillContent);
          const runId = createRun(database, svId, "full", model);
          transitionRun(database, runId, "running");

          // Select real (Anthropic API) vs stub providers ONCE per model so the
          // trigger / execution / judge layers all run against the same backend
          // and the same real `Provider` instance (one key, one transport).
          const providers = selectProviders(model);

          if (!opts.json) {
            console.log(header(`--- Model: ${model} ---`));
            console.log(
              `  Provider: ${providers.real ? "anthropic (REAL — ground truth)" : "STUB (not ground truth)"}`,
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
              provider: providers.real ? "anthropic" : "stub",
              ground_truth: providers.real,
              pkgReport,
              scoreCard,
              decision,
              report,
            };

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
