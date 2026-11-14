import type { Command } from "commander";
import { prepareEvaluationInvocation, type EvalOptions } from "./eval-runtime-context.js";
import { evaluateSingleModel } from "./eval-model-run.js";
import { finalizeEvaluation } from "./eval-finalize.js";
export { resolveRunBudgetLimits } from "./eval-preflight.js";
export {
  resolveClaudeCodeSettings,
  selectJudgeOverride,
  type EvalOptions,
} from "./eval-runtime-context.js";
export { loadRegressionBaseline, formatHeadroom } from "./eval-governance-phase.js";

export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description(
      "Run the binary evaluation on a skill (5 of 7 layers by default; regression + baseline are opt-in, coverage reported in the evidence bundle)",
    )
    .argument("<skill-dir>", "Path to skill directory containing SKILL.md")
    .option("--spec <path>", "Path to eval spec YAML")
    .option(
      "--models <list>",
      "Comma-separated model list. Overrides the spec's `models` when given; " +
        "otherwise the spec's declared models are used (falling back to sonnet).",
      "sonnet",
    )
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--json", "Output as JSON")
    .option(
      "--rollout-file <path>",
      "Retain actual functional prompts and outputs for reviewed bootstrap; creates a private file without overwriting",
    )
    .option("--no-trigger", "Skip trigger tests")
    .option("--no-functional", "Skip functional tests")
    .option(
      "--provider <name>",
      "Force a provider: deepseek | kimi | moonshot | openrouter | groq | nvidia | openai | minimax | " +
        "anthropic | stub (default: auto-detect from env keys, preferring an OpenAI-compatible endpoint)",
    )
    .option(
      "--emit-bundle <path>",
      "Write a gate-result/v1 Evidence Bundle (JSON array of in-toto Statements, one per " +
        "model decision) to <path>. The bundle is kernel-validated on write (fail-closed) and " +
        "linked to each run as an artifact. Consumable directly by intent-rollout-gate.",
    )
    .option(
      "--execution-reasoning-effort <effort>",
      "Explicit reasoning mode for real OpenAI-compatible functional execution only: none | low | medium | high | max. The endpoint must support the selected value. Recorded in evidence; trigger and judge keep their defaults.",
    )
    .option(
      "--mcp-config <path>",
      "Explicit JSON stdio MCP server/tool allowlist for bounded functional execution. " +
        "Starts fresh configured server processes per case; judges receive no tools.",
    )
    .option(
      "--trace-boundary",
      "Log per-test-case execution boundary (text length, tool_calls, status, timed_out, " +
        "empty-output) for the functional pass. Characterizes tool/script-dependent skills a " +
        "single-turn completion eval cannot fully grade. A boundary summary always prints when " +
        "any case hits it; this flag adds the full per-case detail.",
    )
    .option(
      "--judge-provider <name>",
      "Judge on a DIFFERENT backend than the skill-under-test: deepseek | kimi | moonshot | minimax | " +
        "openrouter | groq | nvidia | openai | anthropic | stub. Trigger + execution stay on --provider's " +
        "backend. Fails loud if the requested judge backend has no key. (The judge value " +
        "benchmark: free multi-sampled judges vs a single paid judge.)",
    )
    .option(
      "--judge-model <id>",
      "Override the judge's model id (rides --judge-provider's backend when given, else the " +
        "auto-detected one).",
    )
    .option(
      "--judge-requests-per-minute <n>",
      "Opt-in completion start limit for selected judge endpoints across this invocation (including shared execution traffic); 1..60000, no account-wide quota claim.",
    )
    .option(
      "--samples <n>",
      "Judge samples per judge-method criterion (N-sample majority voting): the verdict is " +
        "the majority vote and `confidence` becomes the measured agreement fraction. " +
        "Overrides the spec's `samples`; a criterion's own `samples` overrides both. " +
        "Default: the spec's `samples`, else 1 (single call).",
    )
    .option(
      "--baseline-check",
      "Layer 5 (Baseline value): run an opt-in naked-model (empty skill body) comparison pass over " +
        "the same test cases; if the skill adds no value over the base model the run is flagged " +
        "obsolete_review. DOUBLES execution+judge cost. Off by default (baseline layer reported skipped).",
    )
    .option(
      "--regression-baseline <path>",
      "Layer 4 (Regression protection): path to a prior run's judgments — a JSON array of " +
        '{ "criterion_id": string, "verdict": "yes"|"no"|"unsure" }. A criterion that passed then and ' +
        "fails now is a regression; a SACRED (regression_critical) regression BLOCKS the rollout. " +
        "Omit to skip the regression layer (reported skipped).",
    )
    .option(
      "--run-self-test",
      "Execute the skill's declared `self_test.command` (a deterministic script) and fold its " +
        "exit-code verdict in as a binary `self-test` criterion — grading the script's observed " +
        "output, not the model's claim. OPT-IN: this runs a command the eval-spec declares, so " +
        "only pass it for skills you trust. The command runs shell-free, in the skill dir, with " +
        "a scoped env (no inherited API keys) and a timeout.",
    )
    .option(
      "--execution-provider <name>",
      "Run the EXECUTION leg on a different backend than --provider. `claude-code` runs each " +
        "test case in real Claude Code (`claude -p --output-format stream-json`) in a fresh temp " +
        "workspace with a copy of the skill, records every tool call and produced file (sha256), " +
        "and enables the trajectory checks (tool_called, tool_not_called, order_before, " +
        "file_exists, file_matches_sha_in). Local Claude subscription ONLY: refuses under CI and " +
        "never uses an API key. Trigger + judge stay on --provider.",
    )
    .option(
      "--workspace-fixtures <dir>",
      "claude-code: directory copied into every test case's workspace (no symlinks).",
    )
    .option(
      "--claude-code-max-turns <n>",
      "claude-code: per-case assistant-turn budget (default 25).",
    )
    .option(
      "--claude-code-timeout-ms <ms>",
      "claude-code: per-case wall-clock budget in ms (default 300000).",
    )
    .option(
      "--claude-code-max-budget-usd <usd>",
      "claude-code: per-case --max-budget-usd passed to Claude Code (API-equivalent $, default 1).",
    )
    .option("--keep-workspaces", "claude-code: keep each case's temp workspace for debugging.")
    .option(
      "--max-usd <usd>",
      "Run budget: stop cleanly once the API-equivalent spend reaches this many USD (all models, " +
        "all phases; subscription claude-code usage counts at list price). Fails closed when a " +
        "model has no rate on file. Tightens, never loosens, the spec's `budget`.",
    )
    .option("--max-tokens <n>", "Run budget: stop cleanly once input+output tokens reach n.")
    .option("--max-wall-ms <ms>", "Run budget: stop cleanly once the eval has run this long.")
    .option("--max-calls <n>", "Run budget: stop cleanly once n metered provider calls are made.")
    .option(
      "--require-reviewed",
      "Refuse a spec still tagged `needs-review` (a `scaffold-spec --draft` output nobody has " +
        "reviewed). The nightly roster passes this so unreviewed drafted criteria never gate.",
    )
    .action(async (skillDir: string, opts: EvalOptions, command: Command) => {
      const startTime = Date.now();

      try {
        const context = await prepareEvaluationInvocation(skillDir, opts, command);
        const {
          models,
          allResults,
          runBudget,
          bundleRows,
          bundleRunIds,
          database,
          absDir,
          skillSnapshotSha,
          spec,
          retainedRollouts,
        } = context;
        let infrastructureFailureSeen = false;
        let budgetStopSeen = false;
        for (const model of models) {
          const result = await evaluateSingleModel(context, model);
          if (result.status === "budget-stopped") {
            budgetStopSeen = true;
            break;
          }
          if (result.infrastructureFailureSeen) infrastructureFailureSeen = true;
        }

        finalizeEvaluation({
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
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
