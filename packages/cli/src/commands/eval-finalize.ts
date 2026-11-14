import { basename, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { writeBundle, type EvidenceStatement } from "@j-rig/core";
import { recordArtifact } from "@j-rig/db";
import type { RunBudget } from "../providers/budget.js";
import { formatDuration } from "../lib/output.js";
import { writeRolloutExport, type RetainedRolloutRun } from "./rollout-export.js";

interface FinalizeInput {
  models: readonly string[];
  allResults: Record<string, unknown>;
  budgetStopSeen: boolean;
  runBudget: RunBudget;
  opts: { json?: boolean; emitBundle?: string; rolloutFile?: string; db: string };
  bundleRows: EvidenceStatement[];
  bundleRunIds: readonly number[];
  database: Parameters<typeof recordArtifact>[0];
  absDir: string;
  skillSnapshotSha: string;
  spec: unknown;
  infrastructureFailureSeen: boolean;
  retainedRollouts: RetainedRolloutRun[];
  startTime: number;
}

/** Flush invocation evidence and output before assigning the terminal exit status. */
export function finalizeEvaluation(input: FinalizeInput): void {
  const {
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
  } = input;
  // A budget stop leaves the remaining models unstarted; say so in the
  // result rather than omitting them. Every row carries the invocation's
  // budget summary when one was set.
  if (budgetStopSeen) {
    for (const m of models) {
      allResults[m] ??= { model: m, skipped: "budget_exhausted" };
    }
  }
  if (runBudget.active) {
    const summary = runBudget.summary();
    for (const m of Object.keys(allResults)) {
      allResults[m] = { ...(allResults[m] as Record<string, unknown>), run_budget: summary };
    }
    if (!opts.json) {
      const { spent, limits } = summary;
      console.log(
        chalk.dim(
          `Budget: ${Object.entries(limits)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")} | spent ${spent.calls} calls, ${spent.tokens} tokens, ` +
            `${spent.wall_ms} ms, ${spent.usd === null ? "USD unpriced" : `$${spent.usd.toFixed(4)}`}`,
        ),
      );
    }
  }

  // ── Evidence Bundle write + artifact linkage (opt-in) ─────────────
  // Write all per-model gate-result/v1 rows as a single JSON array bundle
  // (the in-toto Statement array shape intent-rollout-gate consumes), then
  // link the file to each contributing run as an artifact so the bundle is
  // retrievable from the store for downstream emit.
  if (opts.emitBundle && bundleRows.length > 0) {
    const [bundlePath] = writeBundle(bundleRows, {
      format: "array",
      outputPath: opts.emitBundle,
    });
    // Digest the WRITTEN bytes (not the in-memory rows) so the stored
    // sha256 binds the DB row to the exact file on disk — the DB→bundle
    // link is integrity-checkable, not a mutable path+size pointer.
    // Size and digest come from ONE read so they describe the same bytes
    // (no stat-then-read race). sha256:-prefixed per the platform digest
    // convention (input_hash).
    const bundleBytes = readFileSync(bundlePath);
    const sizeBytes = bundleBytes.byteLength;
    const bundleSha256 = "sha256:" + createHash("sha256").update(bundleBytes).digest("hex");
    for (const rid of bundleRunIds) {
      recordArtifact(
        database,
        rid,
        "evidence-bundle",
        basename(bundlePath),
        bundlePath,
        sizeBytes,
        bundleSha256,
      );
    }
    if (!opts.json) {
      console.log(
        chalk.dim(
          `Evidence Bundle: ${bundlePath} (${bundleRows.length} gate-result/v1 row${
            bundleRows.length === 1 ? "" : "s"
          })`,
        ),
      );
    }
  }

  if (opts.rolloutFile) {
    writeRolloutExport(resolve(opts.rolloutFile), {
      skillId: basename(absDir),
      skillHash: skillSnapshotSha.slice("sha256:".length),
      spec,
      status:
        !infrastructureFailureSeen && !budgetStopSeen && retainedRollouts.length === models.length
          ? "completed"
          : "incomplete",
      runs: retainedRollouts,
    });
  }

  // ── Phase 4: Final output ─────────────────────────────────────────
  const duration = Date.now() - startTime;

  if (opts.json) {
    console.log(JSON.stringify(allResults, null, 2));
  } else {
    console.log(chalk.dim(`Duration: ${formatDuration(duration)} | DB: ${opts.db}`));
  }
  // Exit contract: 0 = evaluated (pass/fail/advisory are VERDICTS and are
  // reported in the bundle, not the exit status — the rollout gate
  // decides); 2 = a provider the evaluation depends on failed for at least one
  // model, so that model was not (fully) evaluated (bundle still written,
  // signed `error`, 000-docs/037); 1 = crash (catch
  // below). Set after every artifact is flushed so consumers still get
  // the bundle + JSON.
  // 3 = a budget limit stopped the run cleanly (no verdict for the
  // stopped model, later models not started); it wins over 2 because
  // the refused calls it caused are not provider failures.
  if (infrastructureFailureSeen) process.exitCode = 2;
  if (budgetStopSeen) process.exitCode = 3;
}
