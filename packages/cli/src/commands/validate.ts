import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import {
  parseAndValidateYaml,
  EvalSpecSchema,
  EvalContractSchema,
} from "@j-rig/core";

/**
 * Register the `validate` command on the given Commander program.
 *
 * Validates an eval spec or eval contract YAML file against the appropriate
 * Zod schema.  The document type is auto-detected from the presence of
 * `contract_version:` in the raw content, and can be overridden with
 * `--contract`.
 *
 * Exit codes:
 *   0 — document is valid
 *   1 — validation failed or an unexpected runtime failure occurred
 */
export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description("Validate an eval spec or eval contract YAML file")
    .argument("<file>", "Path to YAML file")
    .option("--contract", "Validate as eval contract instead of eval spec")
    .option("--json", "Output as JSON")
    .action(
      async (file: string, opts: { contract?: boolean; json?: boolean }) => {
        try {
          const content = readFileSync(resolve(file), "utf-8");

          // Auto-detect document type when --contract is not explicitly passed.
          const isContract =
            opts.contract === true || content.includes("contract_version:");
          const label = isContract ? "eval contract" : "eval spec";

          // Parse through separate branches so TypeScript can resolve the
          // concrete schema type in each call rather than receiving the union.
          const result = isContract
            ? parseAndValidateYaml(content, EvalContractSchema)
            : parseAndValidateYaml(content, EvalSpecSchema);

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  valid: result.success,
                  type: label,
                  errors: result.success ? [] : result.errors,
                },
                null,
                2,
              ),
            );
            process.exit(result.success ? 0 : 1);
            return;
          }

          if (result.success) {
            const data = result.data as Record<string, unknown>;
            const name = (data.skill_name as string) || "unknown";
            console.log(chalk.green(`✓ Valid ${label}: ${name}`));

            if (!isContract) {
              const spec = data as {
                criteria?: unknown[];
                test_cases?: unknown[];
                models?: string[];
              };
              const criteria = spec.criteria?.length ?? 0;
              const cases = spec.test_cases?.length ?? 0;
              const models = (spec.models ?? ["sonnet"]).join(", ");
              console.log(
                `  ${criteria} criteria, ${cases} test cases, models: ${models}`,
              );
            }

            process.exit(0);
          } else {
            console.error(chalk.red(`✗ Invalid ${label}:`));
            for (const e of result.errors) {
              console.error(`  ${e.path}: ${e.message}`);
            }
            process.exit(1);
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      },
    );
}
