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
} from "../providers/anthropic.js";

interface EvalOptions {
  spec?: string;
  models: string;
  db: string;
  json?: boolean;
  trigger?: boolean;
  functional?: boolean;
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
        // ── Phase 1: Load ────────────────────────────────────────────────
        const absDir = resolve(skillDir);
        const { parsed: skill, raw: skillContent } = loadSkillMd(absDir);
        const spec = loadEvalSpec(opts.spec, absDir);
        const models = opts.models.split(",").map((m) => m.trim());
        const database = openDb(opts.db);
        const skillName = skill.frontmatter.name;
        const skillVersion = skill.frontmatter.version ?? "0.0.0";

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
          const svId = getOrCreateSkillVersion(
            database,
            skillName,
            skillVersion,
            skillContent,
          );
          const runId = createRun(database, svId, "full", model);
          transitionRun(database, runId, "running");

          if (!opts.json) console.log(header(`--- Model: ${model} ---`));

          // ── Trigger tests ──────────────────────────────────────────────
          if (opts.trigger !== false) {
            const triggerProvider = new StubTriggerProvider(model);
            const roster = buildRoster(skill.frontmatter, spec.siblings);
            const triggerResults = await runTriggerTests(
              spec.test_cases,
              roster,
              triggerProvider,
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
            const execProvider = new StubExecutionProvider(model);
            const outcomes: ObservedOutcome[] = await runFunctionalTests(
              spec.test_cases,
              skill,
              execProvider,
              { model },
            );

            if (!opts.json) {
              console.log(
                `  Functional: ${outcomes.length}/${spec.test_cases.length} test case(s) executed`,
              );
            }

            // Judge each outcome against all criteria and flatten results.
            const judgeProvider = new StubJudgeProvider(model);
            const allJudgments: JudgmentResult[] = [];

            for (const outcome of outcomes) {
              const judgments = await judgeCriteria(
                spec.criteria,
                outcome,
                judgeProvider,
                { model },
              );
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
                console.log(
                  `    ${verdictIcon} ${j.criterion_id}: ${j.reasoning.slice(0, 80)}`,
                );
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
              [],   // regressions: none in a standalone run
              [],   // baseline: none without a baseline comparison run
              false, // isObsolete: not computed here
            );

            allResults[model] = { pkgReport, scoreCard, decision, report };

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
