import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { RefinerStore } from "@intentsolutions/refiner";
import {
  hashValue,
  makeSkillDoc,
  type EditProposal,
  type EvalSet,
  type ChangeProposal,
} from "@intentsolutions/refiner-core";
import type { Command } from "commander";
import chalk from "chalk";
import { clusterFailures, selectWeakest, createRefinerExperiment } from "@j-rig/core";
import type { FailureCluster } from "@j-rig/core";
import type { JudgmentResult } from "@j-rig/core";
import type { Criterion } from "@j-rig/core";
import { getRecentRuns, getRunResults } from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { header } from "../lib/output.js";

/**
 * Convert a DB criterion result row into the `JudgmentResult` shape required
 * by the core optimizer.  The DB stores `passed: boolean`; the core layer uses
 * `verdict: "yes" | "no" | "unsure"`.
 */
function toJudgmentResult(row: {
  criterion_id: string;
  passed: boolean;
  severity: string;
  message: string;
  method: string | null;
}): JudgmentResult {
  return {
    criterion_id: row.criterion_id,
    verdict: row.passed ? "yes" : "no",
    confidence: 1,
    reasoning: row.message,
    method: row.method === "judge" ? "judge" : "deterministic",
  };
}

/**
 * Build a minimal `Criterion` record from what the DB row carries.
 * The optimizer needs the criteria map to resolve blocker and method fields;
 * since there is no dedicated getCriteria query helper we reconstruct them
 * from the result rows we already hold.
 */
function toCriterion(row: { criterion_id: string; method: string | null }): Criterion {
  return {
    id: row.criterion_id,
    description: row.criterion_id,
    method: row.method === "judge" ? "judge" : "deterministic",
    blocker: false,
    regression_critical: false,
    baseline_sensitive: false,
    pack_sensitive: false,
  };
}

/**
 * Register the `optimize` command on the given Commander program.
 *
 * Loads the most recent (or specified) run's criterion results, converts them
 * to the core `JudgmentResult` format, then calls `clusterFailures` and
 * `selectWeakest` to surface the highest-priority improvement targets.
 */
export function registerOptimizeCommand(
  program: Command,
  runtime: { storeFactory?: (root: string) => RefinerStore; now?: () => string } = {},
): void {
  program
    .command("optimize")
    .description("Analyze failures and suggest improvements for a skill")
    .requiredOption("--skill <name>", "Skill name to optimize")
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--run-id <id>", "Optimize from a specific run", Number)
    .option("--refiner-proposal <hash>", "Bind a stored one-operation edit to a Refiner experiment")
    .option("--skill-dir <path>", "Baseline skill directory for the experiment")
    .option("--eval-set-file <path>", "Reviewed frozen EvalSet JSON")
    .option("--target-item <id>", "Explicit eval-item mapping for the weakest criterion")
    .option("--change-type <type>", "description, instruction, example, trigger, or constraint")
    .option("--expected-impact <text>", "Expected effect of the proposed change")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        skill: string;
        db: string;
        runId?: number;
        json?: boolean;
        refinerProposal?: string;
        skillDir?: string;
        evalSetFile?: string;
        targetItem?: string;
        changeType?: ChangeProposal["change_type"];
        expectedImpact?: string;
      }) => {
        const database = openDb(opts.db);
        try {
          if (opts.runId !== undefined && (!Number.isSafeInteger(opts.runId) || opts.runId <= 0))
            throw new Error("run-id must be a positive safe integer");
          const bridgeFields = [
            opts.refinerProposal,
            opts.skillDir,
            opts.evalSetFile,
            opts.targetItem,
            opts.changeType,
            opts.expectedImpact,
          ];
          const bridge = bridgeFields.some((value) => value !== undefined);
          if (bridge && bridgeFields.some((value) => !value?.trim()))
            throw new Error(
              "Refiner experiments require --refiner-proposal, --skill-dir, --eval-set-file, --target-item, --change-type and --expected-impact",
            );

          // Resolve the target run ID
          let runId = opts.runId;
          if (runId == null) {
            const runs = getRecentRuns(database, { skillName: opts.skill, limit: 1 });
            if (runs.length === 0) {
              throw new Error(`No runs found for skill: ${opts.skill}`);
            }
            runId = runs[0].runs.id;
          }

          const dbResults = getRunResults(database, runId);
          if (dbResults.length === 0) {
            throw new Error(`No results found for run #${runId}`);
          }

          // Convert DB rows → core types
          const judgmentResults: JudgmentResult[] = dbResults.map(toJudgmentResult);
          const criteria: Criterion[] = dbResults.map(toCriterion);

          const clusters: FailureCluster[] = clusterFailures(judgmentResults, criteria);
          const weakest: string | null = selectWeakest(judgmentResults, criteria);

          let optimizer:
            { experiment: ReturnType<typeof createRefinerExperiment>; stored: string } | undefined;
          if (bridge) {
            if (!weakest) throw new Error("No failing criterion to target");
            const sourceRun = database.sqlite
              .prepare(
                `SELECT runs.*, skill_versions.skill_name,
            skill_versions.skill_md_hash FROM runs JOIN skill_versions
            ON runs.skill_version_id = skill_versions.id WHERE runs.id = ?`,
              )
              .get(runId) as
              { status: string; skill_name: string; skill_md_hash: string } | undefined;
            if (
              !sourceRun ||
              sourceRun.status !== "completed" ||
              sourceRun.skill_name !== opts.skill
            )
              throw new Error("Source run must be completed and belong to the requested skill");
            const doc = makeSkillDoc(
              basename(resolve(opts.skillDir!)),
              readFileSync(join(opts.skillDir!, "SKILL.md"), "utf8"),
            );
            // Legacy rows retain a 16-character digest, not a full Refiner content identity.
            if (sourceRun.skill_md_hash !== doc.hash.slice(0, 16))
              throw new Error("Source run skill digest differs from the current baseline");
            if (!/^[0-9a-f]{64}$/.test(opts.refinerProposal!))
              throw new Error("Invalid proposal store hash");
            const store =
              runtime.storeFactory?.(process.cwd()) ?? new RefinerStore({ root: process.cwd() });
            const editProposal = store.get<EditProposal>(opts.refinerProposal!);
            if (!editProposal || hashValue(editProposal) !== opts.refinerProposal)
              throw new Error("Proposal missing or content hash mismatch");
            const evalSet = JSON.parse(readFileSync(opts.evalSetFile!, "utf8")) as EvalSet;
            const evidence = {
              schema: "optimizer-source/v1",
              run: sourceRun,
              results: dbResults,
              doc,
            };
            const change = {
              id: `change-${hashValue({ runId, weakest, editProposal })}`,
              target_criterion: weakest,
              change_type: opts.changeType!,
              description: JSON.stringify(editProposal.ops[0]),
              rationale: editProposal.rationale,
              expected_impact: opts.expectedImpact!,
            };
            const experiment = createRefinerExperiment({
              change,
              doc,
              evalSet,
              editProposal,
              targetItemId: opts.targetItem!,
              source: { runId, criterionId: weakest, evidenceHash: hashValue(evidence) },
              now: runtime.now?.() ?? new Date().toISOString(),
            });
            store.put("optimizer-source", evidence);
            optimizer = { experiment, stored: store.put("optimizer-experiment", experiment) };
          }
          if (opts.json) {
            console.log(
              JSON.stringify(
                { runId, clusters, weakest, ...(optimizer ? { optimizer } : {}) },
                null,
                2,
              ),
            );
          } else {
            if (optimizer)
              console.log(
                `Proposed optimizer experiment: ${optimizer.stored}\nAssess with refine assess --experiment ${optimizer.stored}`,
              );
            console.log(header(`Optimization Analysis: ${opts.skill} (Run #${runId})`));

            if (clusters.length === 0) {
              console.log(chalk.green("\n  No failures to cluster. All criteria passed."));
            } else {
              console.log("\n  Failure Clusters:");
              for (const c of clusters) {
                const color =
                  c.severity === "critical"
                    ? chalk.red
                    : c.severity === "high"
                      ? chalk.yellow
                      : chalk.dim;
                console.log(
                  `    ${color(`[${c.severity.toUpperCase()}]`)} ${c.pattern} (${c.criterion_ids.length} criteria)`,
                );
                for (const id of c.criterion_ids) {
                  console.log(`      - ${id}`);
                }
              }
            }

            if (weakest != null) {
              console.log(`\n  Weakest Criterion: ${chalk.red.bold(weakest)}`);
              console.log(chalk.dim("  Focus improvement efforts here first."));
            } else {
              console.log(chalk.dim("\n  No single weakest criterion identified."));
            }
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exitCode = 1;
        } finally {
          database.close();
        }
      },
    );
}
