import type { Command } from "commander";
import chalk from "chalk";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  checkPackage,
  buildRoster,
  runTriggerTests,
  computeMetrics,
  runFunctionalTests,
  runSelfTest,
  toSelfTestJudgment,
  buildSelfTestCriterion,
  judgeCriteria,
  selectCriteriaForTestCase,
  computeScoreCard,
  decideRollout,
  buildLaunchReport,
  uuidv7,
  emitRuntimeRunStarted,
  emitRuntimeRunFinished,
  emitRuntimeCriterionEvaluated,
  emitJudgeInvoked,
  emitJudgeVerdict,
  emitGateDecisionEmitted,
  composeStatement,
  writeBundle,
  RuntimeTerminalState,
  CriterionOutcome,
  JudgeVerdictSource,
  GateDecision,
  type EvalCorrelation,
} from "@j-rig/core";
import type { JudgmentResult, ObservedOutcome, EvidenceStatement, Criterion } from "@j-rig/core";
import {
  getOrCreateSkillVersion,
  createRun,
  transitionRun,
  storeCriterionResults,
  storeRunSummary,
  recordArtifact,
} from "@j-rig/db";
import { openDb } from "../lib/db.js";
import { loadEvalSpec, loadSkillMd } from "../lib/loaders.js";
import {
  printReport,
  header,
  formatDecision,
  formatScore,
  formatDuration,
  icon,
} from "../lib/output.js";
import {
  StubTriggerProvider,
  StubExecutionProvider,
  StubJudgeProvider,
  assertStubAllowed,
} from "../providers/anthropic.js";
import {
  RealAnthropicProvider,
  AnthropicTriggerProvider,
  AnthropicExecutionProvider,
  AnthropicJudgeProvider,
} from "../providers/anthropic-real.js";
import {
  RealOpenAICompatProvider,
  OpenAICompatTriggerProvider,
  OpenAICompatExecutionProvider,
  OpenAICompatJudgeProvider,
  resolveOpenAICompatConfig,
} from "../providers/openai-compatible.js";
import type { TriggerProvider, ExecutionProvider, JudgeProvider } from "@j-rig/core";

interface EvalOptions {
  spec?: string;
  models: string;
  db: string;
  json?: boolean;
  trigger?: boolean;
  functional?: boolean;
  provider?: string;
  emitBundle?: string;
  traceBoundary?: boolean;
  runSelfTest?: boolean;
}

/** The three eval-pipeline providers a single run needs, plus run metadata. */
interface SelectedProviders {
  trigger: TriggerProvider;
  execution: ExecutionProvider;
  judge: JudgeProvider;
  /** true = real model API (ground truth); false = stub (NOT ground truth). */
  real: boolean;
  /** Short provider name recorded in evidence (`anthropic`/`deepseek`/`stub`/…). */
  providerName: string;
}

/**
 * Select real vs stub providers for a model.
 *
 * Provider precedence (output IS ground truth on any real path):
 *   1. An OpenAI-compatible endpoint — DeepSeek, Kimi/Moonshot, OpenRouter, or a
 *      generic `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` triple. A `--provider`
 *      flag forces a specific preset. This is the default real path because the
 *      Anthropic external-API credit is exhausted; DeepSeek credits are live.
 *   2. The real Anthropic Messages API when `ANTHROPIC_API_KEY` is set.
 *   3. Stub fallback — only if the operator opted in via `J_RIG_ALLOW_STUB=1`.
 *      Without ANY real key AND without the opt-in, `assertStubAllowed()` throws
 *      REFUSED (synthetic ship verdicts are too costly to emit silently).
 *
 * `preferred` comes from the `--provider` flag: when it names a preset
 * (`deepseek`/`kimi`/`moonshot`/`openrouter`), only that preset is considered for
 * the OpenAI-compatible path; `anthropic` skips straight to the Anthropic path;
 * `stub` forces the stub path (still gated by the opt-in).
 */
function selectProviders(model: string, preferred?: string): SelectedProviders {
  const want = preferred?.trim().toLowerCase();

  // Explicit stub request — let the stub constructors enforce the opt-in gate.
  if (want === "stub") {
    return {
      trigger: new StubTriggerProvider(model),
      execution: new StubExecutionProvider(model),
      judge: new StubJudgeProvider(model),
      real: false,
      providerName: "stub",
    };
  }

  // 1. OpenAI-compatible path (DeepSeek / Kimi / OpenRouter / generic LLM_*).
  // Skipped only when the operator explicitly asked for `anthropic`.
  if (want !== "anthropic") {
    const cfg = resolveOpenAICompatConfig(process.env, want);
    if (cfg) {
      // The --models target (haiku/sonnet/opus) is an Anthropic-only label and is
      // NOT a valid vendor model id on the OpenAI-compatible path — sending it to
      // Groq/DeepSeek 404s. Use the configured vendor model (LLM_MODEL / preset
      // defaultModel); fall back to the target only if no vendor model is set.
      const effectiveModel =
        cfg.defaultModel && cfg.defaultModel.length > 0 ? cfg.defaultModel : model;
      const provider = new RealOpenAICompatProvider({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        name: cfg.name,
      });
      return {
        trigger: new OpenAICompatTriggerProvider(effectiveModel, provider),
        execution: new OpenAICompatExecutionProvider(effectiveModel, provider),
        judge: new OpenAICompatJudgeProvider(effectiveModel, provider),
        real: true,
        providerName: cfg.name,
      };
    }
  }

  // 2. Real Anthropic path.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.length >= 8) {
    const provider = new RealAnthropicProvider({ apiKey });
    return {
      trigger: new AnthropicTriggerProvider(model, provider),
      execution: new AnthropicExecutionProvider(model, provider),
      judge: new AnthropicJudgeProvider(model, provider),
      real: true,
      providerName: "anthropic",
    };
  }

  // 3. No real key — stub providers (each constructor re-asserts the opt-in gate).
  return {
    trigger: new StubTriggerProvider(model),
    execution: new StubExecutionProvider(model),
    judge: new StubJudgeProvider(model),
    real: false,
    providerName: "stub",
  };
}

/**
 * Does the environment (and the optional `--provider` preference) expose ANY
 * real provider key? Used to decide whether to short-circuit with the stub
 * opt-in assertion before expensive I/O.
 */
function hasAnyRealKey(preferred?: string): boolean {
  const want = preferred?.trim().toLowerCase();
  if (want === "stub") return false;
  if (want !== "anthropic" && resolveOpenAICompatConfig(process.env, want)) return true;
  if (want === "anthropic" || want === undefined || want === "") {
    return (process.env.ANTHROPIC_API_KEY?.length ?? 0) >= 8;
  }
  return false;
}

/**
 * Register the `eval` command on the given Commander program.
 *
 * Orchestrates all 7 evaluation layers for a skill:
 *   1. Package integrity (deterministic)
 *   2. Trigger simulation (per model)
 *   3. Functional execution (per model)
 *   4. Judgment (per outcome × criterion)
 *   5. Scoring / governance
 *   6. Evidence persistence (SQLite)
 *   7. Launch report + rollout decision
 *
 * Exit codes:
 *   0 — evaluation complete (decision may be warn/obsolete_review)
 *   1 — package integrity hard failure, or unexpected runtime error
 */

/**
 * Resolve a kernel-valid `commit_sha` (7..40 lowercase hex) for the
 * gate-result/v1 predicate, honestly reporting where it came from.
 *
 * Precedence: explicit override → the skill directory's git HEAD (the commit
 * the gate actually evaluated against) → a content-derived 40-hex slice of the
 * skill snapshot sha (for skills that are not git-tracked, e.g. authored in
 * `~/.claude/skills/`). The fallback is NOT a real commit; the source string is
 * recorded in the predicate `metadata.commit_sha_source` so a reader is never
 * misled into treating it as one.
 */
function resolveCommitSha(
  skillDir: string,
  snapshotPrefixed: string,
): { sha: string; source: string } {
  const HEX = /^[a-f0-9]{7,40}$/;
  const env = process.env.JRIG_COMMIT_SHA?.trim();
  if (env && HEX.test(env)) return { sha: env, source: "env:JRIG_COMMIT_SHA" };
  try {
    const head = execFileSync("git", ["-C", skillDir, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (/^[a-f0-9]{40}$/.test(head)) return { sha: head, source: "git:skill-dir-HEAD" };
  } catch {
    /* skill not git-tracked — fall through to the content-derived slice */
  }
  // snapshotPrefixed is "sha256:" + 64 lowercase hex; take the first 40 hex.
  return {
    sha: snapshotPrefixed.slice("sha256:".length, "sha256:".length + 40),
    source: "skill-content-sha (skill not git-tracked)",
  };
}

/**
 * Sanitize an arbitrary string (skill name, model name) into a valid gate-id
 * trailing segment: chars limited to `[A-Za-z0-9.-]` and a leading
 * `[A-Za-z0-9]`, per the kernel SubjectName regex
 * `…:(client|server|ci|sandbox|local):[a-zA-Z0-9][a-zA-Z0-9.-]*`. Both the skill
 * name and the model are passed through this so a SKILL.md with a non-kebab
 * `name` (underscores, leading digit hyphen, etc.) can't produce a gate_id that
 * fails composeStatement's fail-closed validation.
 */
function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description("Run full 7-layer binary evaluation on a skill")
    .argument("<skill-dir>", "Path to skill directory containing SKILL.md")
    .option("--spec <path>", "Path to eval spec YAML")
    .option("--models <list>", "Comma-separated model list", "sonnet")
    .option("--db <path>", "SQLite DB path", "j-rig.db")
    .option("--json", "Output as JSON")
    .option("--no-trigger", "Skip trigger tests")
    .option("--no-functional", "Skip functional tests")
    .option(
      "--provider <name>",
      "Force a provider: deepseek | kimi | moonshot | openrouter | anthropic | stub " +
        "(default: auto-detect from env keys, preferring an OpenAI-compatible endpoint)",
    )
    .option(
      "--emit-bundle <path>",
      "Write a gate-result/v1 Evidence Bundle (JSON array of in-toto Statements, one per " +
        "model decision) to <path>. The bundle is kernel-validated on write (fail-closed) and " +
        "linked to each run as an artifact. Consumable directly by intent-rollout-gate.",
    )
    .option(
      "--trace-boundary",
      "Log per-test-case execution boundary (text length, tool_calls, status, timed_out, " +
        "empty-output) for the functional pass. Characterizes tool/script-dependent skills a " +
        "single-turn completion eval cannot fully grade. A boundary summary always prints when " +
        "any case hits it; this flag adds the full per-case detail.",
    )
    .option(
      "--run-self-test",
      "Execute the skill's declared `self_test.command` (a deterministic script) and fold its " +
        "exit-code verdict in as a binary `self-test` criterion — grading the script's observed " +
        "output, not the model's claim. OPT-IN: this runs a command the eval-spec declares, so " +
        "only pass it for skills you trust. The command runs shell-free, in the skill dir, with " +
        "a scoped env (no inherited API keys) and a timeout.",
    )
    .action(async (skillDir: string, opts: EvalOptions) => {
      const startTime = Date.now();

      try {
        // Provider selection (iaj-E10): when ANTHROPIC_API_KEY is set we run
        // the REAL Anthropic provider and the output is ground truth. Without
        // a key, stub mode is the only available path — and stub-mode opt-in is
        // enforced inside each stub provider constructor (IEP Convergence Debt
        // Plan Priority 2; the gate is structurally inviolable). A
        // belt-and-suspenders assertStubAllowed() is retained at the entry
        // point so the REFUSED error surfaces BEFORE expensive I/O when stub
        // mode is the only path — but ONLY when there is no real key, so a real
        // dogfood run is never gated behind J_RIG_ALLOW_STUB.
        const hasRealKey = hasAnyRealKey(opts.provider);
        if (!hasRealKey) assertStubAllowed();

        // ── Phase 1: Load ────────────────────────────────────────────────
        const absDir = resolve(skillDir);
        const { parsed: skill, raw: skillContent } = loadSkillMd(absDir);
        const spec = loadEvalSpec(opts.spec, absDir);
        const models = opts.models.split(",").map((m) => m.trim());
        const database = openDb(opts.db);
        const skillName = skill.frontmatter.name;
        // Kernel cutover [9k5h.15]: the standard tier is open-world on optional
        // fields, so `version` is `unknown` — narrow before use.
        const skillVersion =
          typeof skill.frontmatter.version === "string" ? skill.frontmatter.version : "0.0.0";

        // OTel correlation inputs (iaj-E08, 067 §§ 1.1, 4.2). The skill
        // snapshot SHA is the content-addressed hash of the raw SKILL.md; the
        // spec content hash hashes the canonical JSON of the loaded eval spec.
        // Both are sha256:-prefixed per the platform digest convention.
        const skillSnapshotSha =
          "sha256:" + createHash("sha256").update(skillContent).digest("hex");
        const specContentHash =
          "sha256:" + createHash("sha256").update(JSON.stringify(spec)).digest("hex");

        if (!opts.json) {
          console.log(header(`j-rig eval: ${skillName}`));
          console.log(`  Models: ${models.join(", ")}\n`);
        }

        // ── Phase 2: Package Integrity ────────────────────────────────────
        const pkgReport = checkPackage(absDir);

        if (!opts.json) {
          console.log(header("--- Package Integrity ---"));
          const { summary } = pkgReport;
          console.log(`  ${summary.passed}/${summary.passed + summary.errors} checks passed`);
        }

        if (pkgReport.summary.errors > 0) {
          if (!opts.json) {
            printReport(pkgReport);
            console.error(chalk.red("\nPackage integrity failed. Fix errors before evaluation."));
          } else {
            console.log(JSON.stringify({ error: "Package integrity failed", pkgReport }, null, 2));
          }
          process.exit(1);
        }

        if (!opts.json) console.log("");

        // ── Phase 3: Per-model evaluation ────────────────────────────────
        const allResults: Record<string, unknown> = {};

        // Evidence Bundle accumulation (opt-in via --emit-bundle): one
        // gate-result/v1 in-toto Statement per model decision, paired with the
        // run id it belongs to. Written + linked as artifacts after the loop.
        const bundleRows: EvidenceStatement[] = [];
        const bundleRunIds: number[] = [];
        const jrigVersion = __CLI_VERSION__ ?? "0.0.0";
        const commit = resolveCommitSha(absDir, skillSnapshotSha);

        // ── Deterministic self-test (opt-in) ─────────────────────────────
        // Run the skill's declared `self_test.command` ONCE (it is
        // model-independent) and fold its verdict into every model's scorecard
        // as a `self-test` criterion. This closes the "script-backed skills
        // under-score" gap: a completion-only eval grades the model reading
        // SKILL.md, never the deterministic script that actually produces the
        // correct verdicts (design principle #3 — observed outranks claimed).
        let selfTestJudgment: JudgmentResult | undefined;
        let selfTestCriterion: Criterion | undefined;
        if (spec.self_test) {
          if (opts.runSelfTest) {
            const st = runSelfTest(spec.self_test, absDir);
            selfTestJudgment = toSelfTestJudgment(st);
            selfTestCriterion = buildSelfTestCriterion(spec.self_test);
            if (!opts.json) {
              const mark = st.passed ? icon("pass") : icon("error");
              console.log(
                `  Self-test: ${mark} ${selfTestJudgment.reasoning}` +
                  (selfTestCriterion.blocker ? " (blocker)" : ""),
              );
            }
          } else if (!opts.json) {
            console.log(
              "  Self-test: skill declares a self_test; re-run with --run-self-test to " +
                "execute it as a deterministic criterion.",
            );
          }
        }

        for (const model of models) {
          const modelStart = Date.now();
          const svId = getOrCreateSkillVersion(database, skillName, skillVersion, skillContent);
          const runId = createRun(database, svId, "full", model);
          transitionRun(database, runId, "running");

          // Select real vs stub providers ONCE per model so the trigger /
          // execution / judge layers all run against the same backend and the
          // same real `Provider` instance (one key, one transport). The
          // optional --provider flag forces a specific vendor.
          const providers = selectProviders(model, opts.provider);

          // OTel: mint a UUIDv7 EvalRun id and emit runtime.run.started
          // (067 § 1.1). The DB integer runId stays the storage key; the
          // UUIDv7 is the cross-emitter idempotency key / lineage anchor.
          const correlation: EvalCorrelation = { evalRunId: uuidv7() };
          emitRuntimeRunStarted(correlation, {
            specContentHash,
            skillSnapshotSha,
          });
          // Did any criterion or gate decision fail? Drives the terminal-state
          // enum on runtime.run.finished.
          let runHadFailure = false;

          if (!opts.json) {
            console.log(header(`--- Model: ${model} ---`));
            console.log(
              `  Provider: ${
                providers.real
                  ? `${providers.providerName} (REAL — ground truth)`
                  : `${providers.providerName.toUpperCase()} (not ground truth)`
              }`,
            );
          }

          // ── Trigger tests ──────────────────────────────────────────────
          if (opts.trigger !== false) {
            const roster = buildRoster(skill.frontmatter, spec.siblings);
            const triggerResults = await runTriggerTests(
              spec.test_cases,
              roster,
              providers.trigger,
            );
            const metrics = computeMetrics(triggerResults);

            if (!opts.json) {
              console.log(
                `  Trigger: precision=${metrics.precision.toFixed(2)} recall=${metrics.recall.toFixed(2)} (${metrics.total_cases} cases)`,
              );
            }
          }

          // ── Functional tests + judgment ────────────────────────────────
          if (opts.functional !== false) {
            const outcomes: ObservedOutcome[] = await runFunctionalTests(
              spec.test_cases,
              skill,
              providers.execution,
              { model },
            );

            if (!opts.json) {
              console.log(
                `  Functional: ${outcomes.length}/${spec.test_cases.length} test case(s) executed`,
              );
            }

            // ── Empty-output boundary instrumentation (bd_000-projects-0xttn) ──
            // A single-turn completion eval captures `output.text` but cannot
            // actually run a skill's tools/scripts, so tool/script-dependent
            // skills surface here as empty/short text with zero tool calls, a
            // `timed_out` meta, a captured `output.error`, or a non-`completed`
            // status. Characterizing that boundary is a precondition for the
            // batch-grade phase (h08j.4): it names the cases a completion-only
            // eval can't fully grade, instead of silently judging a degenerate
            // empty response as if it were a real skill run.
            // `text` is typed as string, but an external provider could return
            // null/undefined; coalesce so the boundary check never throws.
            const boundaryText = (o: ObservedOutcome) => o.output.text ?? "";
            const boundaryCases = outcomes.filter(
              (o) =>
                o.status !== "completed" ||
                o.meta.timed_out ||
                boundaryText(o).trim() === "" ||
                Boolean(o.output.error),
            );
            // Per-case detail goes to STDERR (the diagnostic channel) so it
            // never corrupts machine-readable stdout under --json.
            if (opts.traceBoundary) {
              for (const o of outcomes) {
                console.error(
                  `  [boundary] ${o.test_case_id} model=${model} status=${o.status} ` +
                    `timed_out=${o.meta.timed_out} text_len=${boundaryText(o).length} ` +
                    `tool_calls=${o.output.tool_calls} empty_output=${boundaryText(o).trim() === ""}` +
                    (o.output.error ? ` error=${JSON.stringify(o.output.error)}` : ""),
                );
              }
            }
            if (boundaryCases.length > 0 && !opts.json) {
              console.log(
                `  Boundary: ${boundaryCases.length}/${outcomes.length} test case(s) hit an ` +
                  `empty-output / tool-dependent boundary a completion-only eval can't fully grade ` +
                  `[${boundaryCases.map((o) => o.test_case_id).join(", ")}]` +
                  (opts.traceBoundary
                    ? ""
                    : " — re-run with --trace-boundary for per-case detail."),
              );
            }

            // Judge each outcome against the criteria that test case actually
            // exercises and flatten results. A test case may scope itself via
            // `criteria_ids` (schema default: ALL); honoring it stops an
            // off-topic criterion being judged against an unrelated control
            // prompt — the false-blocker bug that inflated NO-SHIP rates.
            const testCaseById = new Map(spec.test_cases.map((tc) => [tc.id, tc]));
            const allJudgments: JudgmentResult[] = [];

            for (const outcome of outcomes) {
              const testCase = testCaseById.get(outcome.test_case_id);
              // Every outcome originates from a spec test case (runFunctionalTests
              // iterates spec.test_cases), so a miss is an internal invariant
              // break — fail loud rather than silently fall back to ALL criteria.
              if (!testCase) {
                throw new Error(
                  `Outcome references unknown test case id: "${outcome.test_case_id}"`,
                );
              }
              const applicableCriteria = selectCriteriaForTestCase(
                spec.criteria,
                testCase.criteria_ids,
              );
              const judgments = await judgeCriteria(applicableCriteria, outcome, providers.judge, {
                model,
              });

              // OTel per-criterion events (067 §§ 1.1, 1.2). For judge-method
              // criteria we emit judge.invoked + judge.verdict; for every
              // criterion we emit runtime.criterion.evaluated with the binary
              // outcome mapped to the closed {pass,fail,skip} enum.
              for (const j of judgments) {
                if (j.method === "judge") {
                  emitJudgeInvoked(correlation, {
                    judgeId: `j-rig:judge:${j.criterion_id}`,
                    modelId: j.judge_model ?? model,
                    modelVersion: skillVersion,
                  });
                  // A judge with no seed cannot reach RF-2 (066 § 1); j-rig
                  // judges run un-seeded today, so verdict_source is
                  // llm_no_seed and the seed attribute is null (omitted).
                  emitJudgeVerdict(correlation, {
                    verdict: j.verdict,
                    verdictSource: JudgeVerdictSource.LLM_NO_SEED,
                    seed: null,
                  });
                }
                const criterionOutcome =
                  j.verdict === "yes"
                    ? CriterionOutcome.PASS
                    : j.verdict === "unsure"
                      ? CriterionOutcome.SKIP
                      : CriterionOutcome.FAIL;
                if (criterionOutcome === CriterionOutcome.FAIL) runHadFailure = true;
                emitRuntimeCriterionEvaluated(correlation, {
                  matcherClass: j.method,
                  outcome: criterionOutcome,
                });
              }

              allJudgments.push(...judgments);
            }

            const passed = allJudgments.filter((j) => j.verdict === "yes").length;
            const total = allJudgments.length;

            if (!opts.json) {
              console.log(`  Judgment: ${formatScore(passed, total)}`);
              for (const j of allJudgments) {
                const verdictIcon =
                  j.verdict === "yes"
                    ? icon("pass")
                    : j.verdict === "unsure"
                      ? icon("warning")
                      : icon("error");
                console.log(`    ${verdictIcon} ${j.criterion_id}: ${j.reasoning.slice(0, 80)}`);
              }
            }

            // ── Evidence persistence ───────────────────────────────────
            const dbResults = allJudgments.map((j) => ({
              criterion_id: j.criterion_id,
              passed: j.verdict === "yes",
              severity: j.verdict === "yes" ? "pass" : j.verdict === "unsure" ? "warning" : "error",
              message: j.reasoning,
              method: j.method,
            }));
            storeCriterionResults(database, runId, dbResults);

            const errors = allJudgments.filter((j) => j.verdict === "no").length;
            const warnings = allJudgments.filter((j) => j.verdict === "unsure").length;
            storeRunSummary(database, runId, {
              total,
              passed,
              warnings,
              errors,
            });

            // Fold the (model-independent) self-test verdict into THIS model's
            // judgments + scoring criteria so it flows through the same
            // scorecard → blocker → rollout path as every other criterion.
            if (selfTestJudgment) {
              allJudgments.push(selfTestJudgment);
              const stOutcome =
                selfTestJudgment.verdict === "yes" ? CriterionOutcome.PASS : CriterionOutcome.FAIL;
              if (stOutcome === CriterionOutcome.FAIL) runHadFailure = true;
              emitRuntimeCriterionEvaluated(correlation, {
                matcherClass: "deterministic",
                outcome: stOutcome,
              });
            }

            // ── Governance ─────────────────────────────────────────────
            const scoringCriteria = selfTestCriterion
              ? [...spec.criteria, selfTestCriterion]
              : spec.criteria;
            const scoreCard = computeScoreCard(allJudgments, scoringCriteria);
            const decision = decideRollout(scoreCard);
            const report = buildLaunchReport(
              skillName,
              scoreCard,
              [], // regressions: none in a standalone run
              [], // baseline: none without a baseline comparison run
              false, // isObsolete: not computed here
              // DR-103 D5 B5.1: inject `now` so the launch-report artifact is
              // replayable (the determinism the adoption signal's bandit-rejection
              // rests on). One timestamp per model run.
              { now: new Date(modelStart).toISOString() },
            );

            allResults[model] = {
              provider: providers.providerName,
              model,
              ground_truth: providers.real,
              pkgReport,
              scoreCard,
              decision,
              report,
            };

            // OTel gate.decision.emitted (067 § 2.2). Map the j-rig
            // RolloutDecision (ship|warn|block|obsolete_review) onto the closed
            // gate-result/v1 verdict enum {pass,fail,advisory,error}: a clean
            // ship is `pass`, a block is `fail`, warn/obsolete_review are
            // `advisory`. Spelling is identical to the audit-harness iah-E07
            // emitter so a ship-gate dashboard alerts on one event name across
            // both emitters.
            const gateDecisionValue =
              report.decision === "ship"
                ? GateDecision.PASS
                : report.decision === "block"
                  ? GateDecision.FAIL
                  : GateDecision.ADVISORY;
            if (gateDecisionValue === GateDecision.FAIL) runHadFailure = true;
            emitGateDecisionEmitted(correlation, {
              gateName: "j-rig-rollout-gate",
              decision: gateDecisionValue,
              policyRef: specContentHash,
            });

            // ── Evidence Bundle row (opt-in via --emit-bundle) ─────────
            // Compose a real, kernel-validated gate-result/v1 in-toto Statement
            // from this model's rollout decision. composeStatement fail-closes
            // (throws) on any invalid field, so a successfully written bundle is
            // proof-by-construction that every row is kernel-valid and directly
            // consumable by intent-rollout-gate. Reuses the same
            // ship|block|else → pass|fail|advisory mapping as the OTel emit.
            if (opts.emitBundle) {
              const gateDecision =
                report.decision === "ship"
                  ? "pass"
                  : report.decision === "block"
                    ? "fail"
                    : "advisory";
              const gateReasons = [...report.blockers, ...report.warnings];
              if (gateReasons.length === 0) {
                gateReasons.push(report.reasoning || "all criteria met");
              }
              const triggerRan = opts.trigger !== false;
              const statement = composeStatement({
                gateId: `j-rig:local:${sanitizeSegment(skillName, "skill")}.${sanitizeSegment(model, "model")}`,
                gateDecision,
                gateName: "rollout",
                gateVersion: jrigVersion,
                gateReasons,
                coverage: {
                  dimensionsEvaluated: [
                    ...(triggerRan ? ["trigger"] : []),
                    "functional",
                    "behavioral",
                  ],
                  dimensionsSkipped: [...(triggerRan ? [] : ["trigger"]), "regression", "baseline"],
                },
                policyRef: `${specContentHash}:eval-spec.yaml`,
                policyHash: specContentHash,
                inputHash: skillSnapshotSha,
                evaluatedAt: new Date(modelStart).toISOString(),
                runner: `j-rig@${jrigVersion}`,
                commitSha: commit.sha,
                metadata: {
                  model,
                  provider: providers.providerName,
                  ground_truth: providers.real,
                  rollout_decision: report.decision,
                  pass_rate: scoreCard.pass_rate,
                  passed: scoreCard.passed,
                  total_criteria: scoreCard.total_criteria,
                  commit_sha_source: commit.source,
                },
                ...(gateDecision === "fail"
                  ? { failureMode: report.blockers[0] ?? "blocker-criterion-failed" }
                  : {}),
                ...(gateDecision === "advisory" ? { advisorySeverity: "warn" as const } : {}),
              });
              bundleRows.push(statement);
              bundleRunIds.push(runId);
            }

            if (!opts.json) {
              console.log(`  Decision: ${formatDecision(report.decision)}`);
              if (report.blockers.length > 0) {
                for (const b of report.blockers) {
                  console.log(`    ${icon("error")} ${b}`);
                }
              }
              if (report.warnings.length > 0) {
                for (const w of report.warnings) {
                  console.log(`    ${icon("warning")} ${w}`);
                }
              }
              console.log("");
            }

            transitionRun(database, runId, "completed");
          } else {
            transitionRun(database, runId, "completed");
          }

          // OTel runtime.run.finished (067 § 1.1). Terminal state per the
          // EvalRun state machine: a run that produced a failing criterion or a
          // FAIL gate decision is archived_failed; an all-pass run is judged.
          // (archived_success is reserved for the runtime's post-judgment
          // archival lifecycle, which the CLI path does not drive.)
          emitRuntimeRunFinished(correlation, {
            terminalState: runHadFailure
              ? RuntimeTerminalState.ARCHIVED_FAILED
              : RuntimeTerminalState.JUDGED,
            durationMs: Date.now() - modelStart,
          });
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
          const sizeBytes = statSync(bundlePath).size;
          for (const rid of bundleRunIds) {
            recordArtifact(
              database,
              rid,
              "evidence-bundle",
              basename(bundlePath),
              bundlePath,
              sizeBytes,
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

        // ── Phase 4: Final output ─────────────────────────────────────────
        const duration = Date.now() - startTime;

        if (opts.json) {
          console.log(JSON.stringify(allResults, null, 2));
        } else {
          console.log(chalk.dim(`Duration: ${formatDuration(duration)} | DB: ${opts.db}`));
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
