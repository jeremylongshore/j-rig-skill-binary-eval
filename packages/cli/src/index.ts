import { Command } from "commander";
import { registerCheckCommand } from "./commands/check.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerReportCommand } from "./commands/report.js";
import { registerOptimizeCommand } from "./commands/optimize.js";
import { registerDriftCommand } from "./commands/drift.js";
import { registerEmitEvidenceCommand } from "./commands/emit-evidence.js";
import { registerParseAgentsCommand } from "./commands/parse-agents.js";
import { registerMigrateCommand } from "./commands/migrate.js";
import { registerSkillSignalCommands } from "./commands/skill-signals.js";
import { registerRefineCommand } from "@intentsolutions/refiner";

// Report THIS package's own version (not @j-rig/core's "0.0.0" internal stub),
// so an installed `@intentsolutions/jrig-cli` reports its real release version.
// __CLI_VERSION__ is replaced at BUILD time by tsup's esbuild `define` with the
// literal value of packages/cli/package.json#version (see tsup.config.ts) — no
// per-invocation runtime package.json read. The ?? guard keeps `vitest`/`tsx`
// runs (where the define isn't applied) honest rather than emitting `undefined`.
function createProgram(): Command {
  const program = new Command();

  program
    .name("j-rig")
    .description("Seven-layer binary evaluation harness for Claude Skills")
    .version(__CLI_VERSION__ ?? "0.0.0");

  registerCheckCommand(program);
  registerValidateCommand(program);
  registerEvalCommand(program);
  registerReportCommand(program);
  registerOptimizeCommand(program);
  registerDriftCommand(program);
  registerEmitEvidenceCommand(program);
  registerParseAgentsCommand(program);
  registerMigrateCommand(program);
  registerSkillSignalCommands(program);
  registerRefineCommand(program);

  return program;
}

export function main(argv?: string[]): void {
  const program = createProgram();
  program.parse(argv ?? process.argv);
}

// Run when invoked directly (not when imported by tests)
const isDirectRun =
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("j-rig");

if (isDirectRun) {
  main();
}
