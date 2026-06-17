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
        // Stub-mode opt-in is enforced inside each stub provider constructor
        // per IEP Convergence Debt Plan Priority 2 (defense in depth: the
        // gate is structurally inviolable, not merely enforced here). A
        // belt-and-suspenders call is retained at the command-handler entry
        // point so the REFUSED error surfaces BEFORE we do any expensive
        // I/O (loadSkillMd, openDb, loadEvalSpec) when stub mode is the only
        // available path. Removing this call would still be safe — the
        // constructors below would throw first — but the failure message
        // would land mid-pipeline instead of pre-pipeline.
        assertStubAllowed();

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

          if (!opts.json) console.log(header(`--- Model: ${model} ---`));

          // ── Trigger tests ──────────────────────────────────────────────
          if (opts.trigger !== false) {
            const triggerProvider = new StubTriggerProvider(model);
            const roster = buildRoster(skill.frontmatter, spec.siblings);
            const triggerResults = await runTriggerTests(spec.test_cases, roster, triggerProvider);
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
              const judgments = await judgeCriteria(spec.criteria, outcome, judgeProvider, {
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

            allResults[model] = { pkgReport, scoreCard, decision, report };

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
