import { Command } from "commander";
import { registerCheckCommand } from "./commands/check.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerScaffoldSpecCommand } from "./commands/scaffold-spec.js";
import { registerReportCommand } from "./commands/report.js";
import { registerOptimizeCommand } from "./commands/optimize.js";
import { registerDriftCommand } from "./commands/drift.js";
import { registerEmitEvidenceCommand } from "./commands/emit-evidence.js";
import { registerEmitRefinerPassCommand } from "./commands/emit-refiner-pass.js";
import { registerParseAgentsCommand } from "./commands/parse-agents.js";
import { registerMigrateCommand } from "./commands/migrate.js";
import { registerSkillSignalCommands } from "./commands/skill-signals.js";
import { registerRunCommand } from "./commands/run.js";
import { registerGradeCommand } from "./commands/grade.js";
import { registerSamplePlanCommand } from "./commands/sample-plan.js";
import { registerBatchCommand } from "./commands/batch.js";
import { registerEvalBatchCommand } from "./commands/eval-batch.js";
import { registerSuiteCommand } from "./commands/suite.js";
import { emitCostRunRecorded, uuidv7 } from "@j-rig/core";
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
  registerScaffoldSpecCommand(program);
  registerReportCommand(program);
  registerOptimizeCommand(program);
  registerDriftCommand(program);
  registerEmitEvidenceCommand(program);
  registerEmitRefinerPassCommand(program);
  registerParseAgentsCommand(program);
  registerMigrateCommand(program);
  registerSkillSignalCommands(program);
  registerRunCommand(program);
  registerGradeCommand(program);
  registerSamplePlanCommand(program);
  registerBatchCommand(program);
  registerEvalBatchCommand(program);
  registerSuiteCommand(program);
  registerRefineCommand(program, undefined, {
    onCostOutcome: (report) => {
      emitCostRunRecorded(
        {
          evalRunId: uuidv7(),
          refinerAttemptId: report.attemptId,
          refinerFileId: report.fileId,
          refinerPolicyHash: report.policyHash,
          costRecordScope: "refiner-attempt",
        },
        {
          totalInputTokens: report.inputTokens,
          totalOutputTokens: report.outputTokens,
          totalCalls: report.calls,
          estimatedUsd: report.unknownCalls ? null : report.knownMicros / 1_000_000,
          usageComplete: report.unknownCalls === 0,
          unknownCalls: report.unknownCalls,
          fileKnownUsd: report.file.knownMicros / 1_000_000,
          fileCommittedUsd: report.file.committedMicros / 1_000_000,
          fileAccepted: report.file.accepted,
          filePerAcceptUsd:
            report.file.costPerAcceptMicros === null
              ? null
              : report.file.costPerAcceptMicros / 1_000_000,
          outcome: report.decision,
          p0: report.p0,
        },
      );
    },
  });

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
