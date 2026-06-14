import type { Command } from "commander";
import { resolve } from "node:path";
import chalk from "chalk";
import { runCodemod, nodeFs } from "@j-rig/migrate";

/**
 * Register the `migrate` command on the given Commander program.
 *
 * Walks `<dir>` for Evidence Bundle JSON fixtures in the v0.1.0-draft shape and
 * rewrites them to the v2.0 kernel `gate-result/v1` shape. DRY RUN by default:
 * prints a unified diff per changed file and writes nothing. Pass `--write` to
 * apply the changes in place.
 *
 * Exit codes:
 *   0 — completed (whether or not files changed); no parse errors
 *   1 — at least one file failed to parse, or a runtime error occurred
 */
export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate")
    .description("Rewrite v0.1.0-draft Evidence Bundle fixtures to the v2.0 gate-result/v1 shape")
    .argument("<dir>", "Directory to scan for *.json Evidence Bundle fixtures")
    .option("--write", "Apply the migration in place (default: dry run / diff only)")
    .option("--json", "Output the per-file report as JSON")
    .action((dir: string, opts: { write?: boolean; json?: boolean }) => {
      // Exit once at the end (see parse-agents for the rationale).
      process.exit(runMigrate(dir, opts));
    });
}

/** Pure-ish command body: returns the exit code, performs all console output. */
export function runMigrate(dir: string, opts: { write?: boolean; json?: boolean }): number {
  let result;
  const target = resolve(dir);
  try {
    result = runCodemod(target, nodeFs, { write: opts.write === true });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          dir: target,
          wrote: opts.write === true,
          changedCount: result.changedCount,
          errorCount: result.errorCount,
          files: result.files.map((f) => ({
            path: f.path,
            changed: f.changed,
            written: f.written,
            parseError: f.parseError,
            rows: f.rows,
          })),
        },
        null,
        2,
      ),
    );
    return result.errorCount > 0 ? 1 : 0;
  }

  if (result.files.length === 0) {
    console.log(chalk.yellow(`No JSON fixtures found under ${target}`));
    return 0;
  }

  for (const f of result.files) {
    if (f.parseError !== null) {
      console.error(chalk.red(`✗ ${f.path}: parse error — ${f.parseError}`));
      continue;
    }
    if (!f.changed) continue;
    console.log(
      opts.write ? chalk.green(`✓ migrated ${f.path}`) : chalk.cyan(`~ would migrate ${f.path}`),
    );
    if (!opts.write) console.log(f.diff);
  }

  const verb = opts.write ? "migrated" : "would migrate";
  console.log(
    `\n${result.changedCount} file(s) ${verb}` +
      (result.errorCount > 0 ? chalk.red(`, ${result.errorCount} parse error(s)`) : "") +
      (opts.write ? "" : chalk.dim("  (dry run — pass --write to apply)")),
  );

  return result.errorCount > 0 ? 1 : 0;
}
