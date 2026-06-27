import { createRequire } from "node:module";
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
// Read from package.json at runtime via createRequire — robust in an ESM bundle
// regardless of where the bin is installed.
function resolveCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function createProgram(): Command {
  const program = new Command();

  program
    .name("j-rig")
    .description("Seven-layer binary evaluation harness for Claude Skills")
    .version(resolveCliVersion());

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
