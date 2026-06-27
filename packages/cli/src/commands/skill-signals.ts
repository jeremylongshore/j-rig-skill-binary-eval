import type { Command } from "commander";
import chalk from "chalk";
import {
  recordSkillUsage,
  recordSkillReview,
  countVerifiedUsage,
  countReviews,
  CASS_PASS_THRESHOLD,
  type CassInputs,
  type UsageEventSource,
} from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { header, icon } from "../lib/output.js";

/**
 * `j-rig ingest-skill` + `j-rig review` — the skill-signal INTAKE verbs
 * (epic intent-eval-lab#206, bead bd_000-projects-ig4h.5; build-ready spec Item 5;
 * ISEDC DR-103 D1/D2/D5).
 *
 * - `j-rig ingest-skill <skill-id>` captures ONE usage event, GATED by a CASS
 *   session-quality score (≥ 0.30 PASS). A failing row is persisted-but-excluded
 *   (`cass_passed = 0`, never counted) — load-to-inflate is visible in the data,
 *   not silently dropped. There is NO `--force-count` path.
 * - `j-rig review <skill-id>` captures a CURATED-SIGNAL thumb + open-ended TEXT
 *   rationale. Explicitly NOT a signed in-toto `human-review/v1` predicate and
 *   never a trust root (DR-103 D3 B3.2 / doc 072 R6).
 *
 * Both write LOCAL SQLite fact tables via `@j-rig/db` (the tenant column lands in
 * the FIRST CREATE TABLE per D2 B2.1). OTel stays OFF — the OTel name set is
 * closed/normative (doc 067); no `usage.*`/`review.*` events are minted here.
 *
 * The CASS gate, the persist-but-exclude discipline, and the rollup C3-safety all
 * live in the pure `@j-rig/db` skill-signals module; these verbs are thin shims
 * that parse flags, compute the timestamp at the I/O edge, and print a result.
 */

/** Collect the CASS session-quality flags from the command options. */
function collectCass(opts: {
  testsPassed?: boolean;
  clearResolution?: boolean;
  codeChanges?: boolean;
  userConfirmed?: boolean;
  backtracking?: boolean;
  abandoned?: boolean;
}): CassInputs {
  return {
    testsPassed: opts.testsPassed === true,
    clearResolution: opts.clearResolution === true,
    codeChanges: opts.codeChanges === true,
    userConfirmed: opts.userConfirmed === true,
    backtracking: opts.backtracking === true,
    abandoned: opts.abandoned === true,
  };
}

/** Register the `ingest-skill` and `review` intake verbs on the program. */
export function registerSkillSignalCommands(program: Command): void {
  // ── j-rig ingest-skill ──────────────────────────────────────────────────────
  program
    .command("ingest-skill")
    .description(
      "Record one CASS-gated skill usage event (verified-session-gated; never raw loads)",
    )
    .argument("<skill-id>", "kebab-slug skill id the usage is for")
    .requiredOption("--session-id <id>", "Opaque id of the CASS-gated session")
    .option(
      "--source <ci|plugin>",
      "Provenance: ci (gate-anchored, trusted) | plugin (unverified)",
      "plugin",
    )
    .option("--tests-passed", "CASS signal: tests ran and passed (+0.25)")
    .option("--clear-resolution", "CASS signal: session reached a clear resolution (+0.25)")
    .option("--code-changes", "CASS signal: session produced code changes (+0.15)")
    .option("--user-confirmed", "CASS signal: user confirmed the result was useful (+0.15)")
    .option("--backtracking", "CASS signal: session involved backtracking (-0.10)")
    .option("--abandoned", "CASS signal: session was abandoned (-0.20)")
    .option("--tenant <id>", "Tenant bucket (omit for the single-tenant/global bucket)")
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--json", "Output as JSON")
    .action(
      (
        skillId: string,
        opts: {
          sessionId: string;
          source?: string;
          testsPassed?: boolean;
          clearResolution?: boolean;
          codeChanges?: boolean;
          userConfirmed?: boolean;
          backtracking?: boolean;
          abandoned?: boolean;
          tenant?: string;
          db: string;
          json?: boolean;
        },
      ) => {
        try {
          const source = (opts.source ?? "plugin").trim().toLowerCase();
          if (source !== "ci" && source !== "plugin") {
            console.error(`Error: --source must be 'ci' or 'plugin' (got '${opts.source}')`);
            process.exit(1);
          }
          const cass = collectCass(opts);
          const database = openDb(opts.db);
          // Always release the SQLite handle — success, `--json` early return, or
          // a throw inside record/print all flow through the `finally`.
          try {
            const rec = recordSkillUsage(database, {
              skillId,
              sessionId: opts.sessionId,
              source: source as UsageEventSource,
              cass,
              ...(opts.tenant !== undefined ? { tenantId: opts.tenant } : {}),
              // Timestamp at the I/O edge — the CLI is the wall-clock boundary; the
              // persistence + rollup layers stay deterministic on injected values.
              recordedAt: new Date().toISOString(),
            });

            if (opts.json) {
              console.log(JSON.stringify(rec, null, 2));
              return;
            }
            console.log(header(`j-rig ingest-skill: ${skillId}`));
            console.log(
              `  CASS: ${rec.cassScore.toFixed(2)} (threshold ${CASS_PASS_THRESHOLD}) — ` +
                (rec.cassPassed
                  ? `${icon("pass")} PASS — counts toward verified adoption`
                  : `${icon("warning")} FAIL — persisted but EXCLUDED from adoption (anti-gaming)`),
            );
            console.log(
              `  source: ${rec.source}${rec.tenantId ? ` | tenant: ${rec.tenantId}` : ""}`,
            );
            if (!rec.cassPassed) {
              console.log(
                chalk.dim(
                  "  Note: a low-quality session is recorded but never counted. There is no force-count flag.",
                ),
              );
            }
          } finally {
            database.close();
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      },
    );

  // ── j-rig review ────────────────────────────────────────────────────────────
  program
    .command("review")
    .description(
      "Record a curated-signal human thumb + open-ended rationale (NOT a signed predicate)",
    )
    .argument("<skill-id>", "kebab-slug skill id the review is for")
    .requiredOption("--verdict <up|down>", "Coarse thumb: up | down")
    .option("--rationale <text>", "Open-ended free-text rationale (non-comparable; never parsed)")
    .option("--reviewer <id>", "Reviewer identity (email/handle)", "unknown")
    .option("--tenant <id>", "Tenant bucket (omit for the single-tenant/global bucket)")
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--json", "Output as JSON")
    .action(
      (
        skillId: string,
        opts: {
          verdict: string;
          rationale?: string;
          reviewer: string;
          tenant?: string;
          db: string;
          json?: boolean;
        },
      ) => {
        try {
          const v = opts.verdict.trim().toLowerCase();
          if (v !== "up" && v !== "down") {
            console.error(`Error: --verdict must be 'up' or 'down' (got '${opts.verdict}')`);
            process.exit(1);
          }
          const database = openDb(opts.db);
          // Always release the SQLite handle — success, `--json` early return, or
          // a throw inside record/print all flow through the `finally`.
          try {
            const rec = recordSkillReview(database, {
              skillId,
              thumbsUp: v === "up",
              ...(opts.rationale !== undefined ? { rationale: opts.rationale } : {}),
              reviewer: opts.reviewer,
              ...(opts.tenant !== undefined ? { tenantId: opts.tenant } : {}),
              recordedAt: new Date().toISOString(),
            });

            if (opts.json) {
              console.log(JSON.stringify(rec, null, 2));
              return;
            }
            console.log(header(`j-rig review: ${skillId}`));
            console.log(
              `  ${rec.thumbsUp ? icon("pass") : icon("error")} thumb ${rec.thumbsUp ? "up" : "down"} ` +
                `by ${rec.reviewer} (${rec.governanceClass})`,
            );
            if (rec.rationale) console.log(`  rationale: ${rec.rationale}`);
            console.log(
              chalk.dim(
                "  Note: curated-signal — NOT a signed human-review/v1 predicate, never a trust root.",
              ),
            );
          } finally {
            database.close();
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      },
    );
}

/**
 * Exported for the report surface (a future `report --usage/--reviews` lane).
 * Re-exported so a consuming command can render the C3-safe per-dimension counts
 * without re-importing from `@j-rig/db` directly.
 */
export { countVerifiedUsage, countReviews };
