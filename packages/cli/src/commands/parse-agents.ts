import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { parseAgentsMd } from "@j-rig/core";

/**
 * Register the `parse-agents` command on the given Commander program.
 *
 * Parses an AGENTS.md file (the open agent-tooling convention) into a typed
 * structure: frontmatter, title, H2/H3 sections, extracted build/test/lint/
 * setup/style/format commands, and tools / capabilities / constraints bullets.
 *
 * Exit codes:
 *   0 — parsed successfully
 *   1 — parse failure (broken frontmatter) or runtime error
 */
export function registerParseAgentsCommand(program: Command): void {
  program
    .command("parse-agents")
    .description("Parse an AGENTS.md file into a typed structure")
    .argument("[file]", "Path to AGENTS.md", "AGENTS.md")
    .option("--json", "Output the full parsed structure as JSON")
    .action((file: string, opts: { json?: boolean }) => {
      // Compute the exit code first, then exit once at the end. Keeping the
      // exit OUTSIDE the try means a runtime error can't be masked by an
      // exit-throwing test harness, and the success path exits cleanly.
      process.exit(runParseAgents(file, opts));
    });
}

/** Pure-ish command body: returns the exit code, performs all console output. */
export function runParseAgents(file: string, opts: { json?: boolean }): number {
  let content: string;
  try {
    content = readFileSync(resolve(file), "utf-8");
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  const result = parseAgentsMd(content);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: result.success,
          data: result.success ? result.data : null,
          errors: result.success ? [] : result.errors,
        },
        null,
        2,
      ),
    );
    return result.success ? 0 : 1;
  }

  if (!result.success) {
    console.error(chalk.red(`✗ Failed to parse ${file}:`));
    for (const e of result.errors) {
      console.error(`  ${e.path || "<root>"}: ${e.message}`);
    }
    return 1;
  }

  const d = result.data;
  console.log(chalk.green(`✓ Parsed ${file}`));
  console.log(`  Title: ${d.title || chalk.dim("(none)")}`);
  console.log(`  Sections: ${d.sections.length}`);

  const commandKinds = Object.keys(d.commands);
  if (commandKinds.length > 0) {
    console.log(`  Commands:`);
    for (const kind of commandKinds) {
      const cmds = d.commands[kind as keyof typeof d.commands] ?? [];
      console.log(`    ${kind}: ${cmds.length} command${cmds.length === 1 ? "" : "s"}`);
    }
  }
  if (d.tools.length > 0) console.log(`  Tools: ${d.tools.length}`);
  if (d.capabilities.length > 0) console.log(`  Capabilities: ${d.capabilities.length}`);
  if (d.constraints.length > 0) console.log(`  Constraints: ${d.constraints.length}`);

  return 0;
}
