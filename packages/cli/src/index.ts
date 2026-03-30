import { Command } from "commander";
import { VERSION } from "@j-rig/core";
import { registerCheckCommand } from "./commands/check.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerReportCommand } from "./commands/report.js";
import { registerOptimizeCommand } from "./commands/optimize.js";
import { registerDriftCommand } from "./commands/drift.js";

function createProgram(): Command {
  const program = new Command();

  program
    .name("j-rig")
    .description("Seven-layer binary evaluation harness for Claude Skills")
    .version(VERSION);

  registerCheckCommand(program);
  registerValidateCommand(program);
  registerEvalCommand(program);
  registerReportCommand(program);
  registerOptimizeCommand(program);
  registerDriftCommand(program);

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
