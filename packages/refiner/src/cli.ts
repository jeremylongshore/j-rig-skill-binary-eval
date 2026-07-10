/**
 * `j-rig refine` command group — the 5 Skill Refiner CLI commands (plan 027 § 4
 * Phase A build-order step 7; "thin shim over orchestrator").
 *
 *   j-rig refine bootstrap <skill-dir>   — synthesize a held-out eval set
 *   j-rig refine score <skill-dir>       — delegate scoring to `j-rig eval`
 *   j-rig refine propose <skill-dir>     — propose a bounded edit (tiered model)
 *   j-rig refine apply <skill-dir>       — apply a stored proposal → new version
 *   j-rig refine status <skill-id>       — show the refiner store / event log
 *   j-rig refine render-report <md>      — deterministic markdown → self-contained HTML
 *
 * The command group is BUILT here, in the `@intentsolutions/refiner` package, so the
 * orchestration logic ships with the refiner — the only edit in `@intentsolutions/jrig-cli` is a
 * single line that calls {@link registerRefineCommand} (the surgical wiring the
 * plan permits). Each command is a thin shim: it loads inputs, calls the pure
 * refiner-core ops + this package's adapters/store, and prints a result. Heavy
 * model + evaluator I/O is reached only through the injectable seams, so the
 * commands stay testable.
 *
 * Commands that would require a live model/evaluator key (`score`, `propose`)
 * fail loudly with guidance rather than fabricating a result; the deterministic
 * commands (`bootstrap`, `apply`, `status`) run fully offline.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  makeSkillDoc,
  bootstrap,
  applyEdit,
  type SkillDoc,
  type EditProposal,
} from "@intentsolutions/refiner-core";
import { RefinerStore } from "./store.js";
import { score, createSubprocessEvalRunner } from "./score.js";
import {
  propose,
  createCompletionClient,
  resolveProvider,
  NoProviderError,
  type ProposeModelTier,
  type ProposeModelOptions,
} from "./propose.js";
import {
  NaiveInContextStrategy,
  SkillOptStyleStrategy,
  type RefinerStrategy,
} from "@intentsolutions/refiner-core";
import { renderReportHtml, ReportRenderError } from "./report-render.js";

/** Load the SKILL.md in `skillDir` into a content-addressed SkillDoc. */
function loadSkillDoc(skillDir: string): SkillDoc {
  const path = join(skillDir, "SKILL.md");
  const text = readFileSync(path, "utf8");
  // skillId = directory basename (the conventional skill slug).
  const skillId = skillDir.replace(/\/+$/, "").split("/").pop() || skillDir;
  return makeSkillDoc(skillId, text);
}

/** Select a strategy by id, defaulting to the SkillOpt-style refiner. */
function selectStrategy(id?: string): RefinerStrategy {
  switch (id) {
    case "naive-in-context":
    case "naive-in-context/v1":
      return new NaiveInContextStrategy();
    case undefined:
    case "skill-opt-style":
    case "skill-opt-style/v1":
      return new SkillOptStyleStrategy();
    default:
      throw new Error(
        `unknown refiner strategy '${id}' (use 'skill-opt-style' or 'naive-in-context')`,
      );
  }
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/**
 * Register the `refine` command group on the given Commander program.
 *
 * @param program        The j-rig CLI program (from @intentsolutions/jrig-cli).
 * @param storeFactory   Injectable RefinerStore factory (default: node-fs store
 *                       rooted at cwd). Tests pass a fake-fs-backed store.
 */
export function registerRefineCommand(
  program: Command,
  storeFactory: (root: string) => RefinerStore = (root) => new RefinerStore({ root }),
): void {
  const refine = program
    .command("refine")
    .description("Eval-guided SKILL.md improvement loop (Skill Refiner)");

  // ── bootstrap ──────────────────────────────────────────────────────────────
  refine
    .command("bootstrap")
    .description("Synthesize a held-out eval set from a SKILL.md")
    .argument("<skill-dir>", "Path to the skill directory containing SKILL.md")
    .option("--quick", "Quick mode: skip refresh-due-at (casual contributors)")
    .option("--json", "Output as JSON")
    .action((skillDir: string, opts: { quick?: boolean; json?: boolean }) => {
      try {
        const doc = loadSkillDoc(skillDir);
        const evalSet = bootstrap(doc, { quick: opts.quick, now: new Date().toISOString() });
        const store = storeFactory(process.cwd());
        store.putSkillDoc(doc);
        store.putEvalSet(evalSet);
        if (opts.json) {
          console.log(JSON.stringify(evalSet, null, 2));
        } else {
          console.log(`Bootstrapped eval set for '${doc.skillId}'`);
          console.log(`  items:    ${evalSet.items.length}`);
          console.log(`  version:  ${evalSet.evalSetVersion}`);
          console.log(`  hash:     ${evalSet.hash.slice(0, 12)}`);
          console.log(`  stored:   .j-rig/refiner/store/${evalSet.hash.slice(0, 12)}…`);
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  // ── score ────────────────────────────────────────────────────────────────
  refine
    .command("score")
    .description("Score a skill by delegating to `j-rig eval` (any provider)")
    .argument("<skill-dir>", "Path to the skill directory containing SKILL.md")
    .option("--eval-set <hash>", "Eval-set hash to score against (defaults to bootstrap)")
    .option(
      "--provider <name>",
      "LLM backend: nvidia | deepseek | groq | anthropic | kimi | openrouter " +
        "(default: auto-pick the first present key, preferring free/cheap; Anthropic is NOT required)",
    )
    .option(
      "--model <id>",
      "Scoring model. Anthropic: haiku | sonnet (never opus). OpenAI-compatible " +
        "providers: a raw vendor model id (defaults to the provider's default).",
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        skillDir: string,
        opts: { evalSet?: string; provider?: string; model?: string; json?: boolean },
      ) => {
        try {
          // Resolve the backend the SAME way propose() does, so `refine score`
          // never hard-requires Anthropic and agrees with `j-rig eval`.
          let resolved;
          try {
            resolved = resolveProvider({ provider: opts.provider });
          } catch (err) {
            if (err instanceof NoProviderError) fail(err.message);
            throw err;
          }

          // Model discipline is per-format: Anthropic keeps the haiku|sonnet tier
          // (opus is validation-only); OpenAI-compatible providers accept a raw
          // vendor id and default to the provider's default model.
          let modelTier: string;
          if (resolved.format === "anthropic") {
            modelTier = opts.model ?? "sonnet";
            if (modelTier !== "haiku" && modelTier !== "sonnet") {
              fail(
                `--model must be haiku or sonnet on the anthropic provider (got '${opts.model}'); ` +
                  `opus is validation-only`,
              );
            }
          } else {
            modelTier = opts.model ?? resolved.defaultModel;
            // A generic LLM_* endpoint without LLM_MODEL (or a preset lacking a
            // default) yields an empty model id. Fail here with an actionable
            // message rather than spawning `j-rig eval --models ""` downstream.
            if (!modelTier) {
              fail(
                `provider '${resolved.name}' has no default model — pass --model <vendor-model-id> ` +
                  `(or set LLM_MODEL when using a generic LLM_* endpoint)`,
              );
            }
          }

          const doc = loadSkillDoc(skillDir);
          const store = storeFactory(process.cwd());
          // Resolve the eval set: an explicit --eval-set hash from the store, else
          // a fresh deterministic bootstrap so `score` works standalone.
          const evalSet = opts.evalSet
            ? store.get<ReturnType<typeof bootstrap>>(opts.evalSet)
            : bootstrap(doc, { now: new Date().toISOString() });
          if (evalSet === null) {
            fail(`eval set ${opts.evalSet} not found in the refiner store`);
          }
          store.putSkillDoc(doc);
          store.putEvalSet(evalSet);
          const runner = createSubprocessEvalRunner();
          const record = await score(doc, evalSet, runner, {
            skillDir,
            modelTier,
            provider: resolved.name,
          });
          store.putScoreRecord(record);
          if (opts.json) {
            console.log(JSON.stringify(record, null, 2));
          } else {
            console.log(`Scored '${doc.skillId}' (${resolved.name} / ${modelTier})`);
            console.log(
              `  behavioral: ${record.behavioral.value.toFixed(4)} (n=${record.behavioral.n})`,
            );
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    );

  // ── propose ────────────────────────────────────────────────────────────────
  refine
    .command("propose")
    .description("Propose a bounded SKILL.md edit (any provider; free/cheap by default)")
    .argument("<skill-dir>", "Path to the skill directory containing SKILL.md")
    .option("--strategy <id>", "Strategy: skill-opt-style | naive-in-context", "skill-opt-style")
    .option(
      "--provider <name>",
      "LLM backend: nvidia | deepseek | groq | anthropic | kimi | openrouter " +
        "(default: auto-pick the first present key, preferring free/cheap; Anthropic is NOT required)",
    )
    .option(
      "--model <id>",
      "Propose model. Anthropic: haiku | sonnet (never opus). OpenAI-compatible " +
        "providers: a raw vendor model id (defaults to the provider's default).",
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        skillDir: string,
        opts: { strategy?: string; provider?: string; model?: string; json?: boolean },
      ) => {
        try {
          // PROVIDER-AGNOSTIC: resolve a backend from --provider / LLM_* / the
          // first present key (preferring free/cheap). No Anthropic requirement.
          let resolved;
          try {
            resolved = resolveProvider({ provider: opts.provider });
          } catch (err) {
            if (err instanceof NoProviderError) fail(err.message);
            throw err;
          }

          // Model discipline is per-format. Anthropic: haiku|sonnet tier + the
          // no-opus guard (applied inside createRefinerModel). OpenAI-compatible:
          // a raw vendor model id, defaulting to the provider's default.
          let proposeOpts: ProposeModelOptions;
          if (resolved.format === "anthropic") {
            const tier = (opts.model ?? "sonnet") as ProposeModelTier;
            if (tier !== "haiku" && tier !== "sonnet") {
              fail(
                `--model must be haiku or sonnet on the anthropic provider (got '${opts.model}'); ` +
                  `opus is validation-only`,
              );
            }
            proposeOpts = { format: "anthropic", tier };
          } else {
            const model = opts.model ?? resolved.defaultModel;
            // Same empty-model-id guard as `score`: fail early in the CLI with an
            // actionable message rather than after setup with a ProposeAdapterError.
            if (!model) {
              fail(
                `provider '${resolved.name}' has no default model — pass --model <vendor-model-id> ` +
                  `(or set LLM_MODEL when using a generic LLM_* endpoint)`,
              );
            }
            proposeOpts = { format: "openai", model };
          }

          const doc = loadSkillDoc(skillDir);
          const strategy = selectStrategy(opts.strategy);
          const store = storeFactory(process.cwd());
          store.putSkillDoc(doc);
          // Build the client that matches the resolved provider's wire format
          // (Anthropic Messages vs OpenAI Chat Completions).
          const client = createCompletionClient(resolved);
          // No scored rollouts on the CLI path yet (harvest is wave 2+); the
          // strategies tolerate an empty rollout set (single-pass proposal).
          const proposal = await propose(strategy, { doc, rollouts: [] }, client, proposeOpts);
          const hash = store.putEditProposal(proposal);
          if (opts.json) {
            console.log(JSON.stringify(proposal, null, 2));
          } else {
            console.log(`Proposed ${proposal.ops.length} op(s) for '${doc.skillId}'`);
            console.log(`  provider: ${resolved.name}`);
            console.log(`  strategy: ${proposal.refinerStrategyId}`);
            console.log(`  model:    ${proposal.refinerModel}`);
            console.log(`  stored:   .j-rig/refiner/store/${hash.slice(0, 12)}…`);
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    );

  // ── apply ────────────────────────────────────────────────────────────────
  refine
    .command("apply")
    .description("Apply a stored EditProposal to a SKILL.md → a new immutable version")
    .argument("<skill-dir>", "Path to the skill directory containing SKILL.md")
    .requiredOption("--proposal <hash>", "Content hash of the stored EditProposal")
    .option("--json", "Output as JSON")
    .action((skillDir: string, opts: { proposal: string; json?: boolean }) => {
      try {
        const doc = loadSkillDoc(skillDir);
        const store = storeFactory(process.cwd());
        const proposal = store.get<EditProposal>(opts.proposal);
        if (proposal === null) {
          fail(`proposal ${opts.proposal} not found in the refiner store`);
        }
        const next = applyEdit(doc, proposal); // throws on parent mismatch / bad anchor
        const hash = store.putSkillDoc(next);
        if (opts.json) {
          console.log(JSON.stringify({ skillId: next.skillId, hash, text: next.text }, null, 2));
        } else {
          console.log(`Applied proposal → new version of '${next.skillId}'`);
          console.log(`  parent: ${doc.hash.slice(0, 12)}`);
          console.log(`  new:    ${hash.slice(0, 12)}`);
          console.log(`  NOTE: candidate version stored; promote with a human-gated 'best' move.`);
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  // ── status ─────────────────────────────────────────────────────────────────
  refine
    .command("status")
    .description("Show the refiner store state + event log for a skill")
    .argument("<skill-id>", "Skill id (directory basename) to report on")
    .option("--json", "Output as JSON")
    .action((skillId: string, opts: { json?: boolean }) => {
      try {
        const store = storeFactory(process.cwd());
        const best = store.getBest(skillId);
        const log = store.readLog();
        const forSkill = log.filter(
          (e) => (e.type === "best-pointer-moved" && e.skillId === skillId) || e.type === "stored",
        );
        if (opts.json) {
          console.log(JSON.stringify({ skillId, best, events: forSkill }, null, 2));
        } else {
          console.log(`Refiner status: ${skillId}`);
          console.log(`  best:   ${best ? best.slice(0, 12) : "(unset)"}`);
          console.log(`  events: ${forSkill.length} in log.jsonl`);
          for (const e of forSkill.slice(-10)) {
            if (e.type === "stored") {
              console.log(`    stored ${e.kind} ${e.hash.slice(0, 12)} @ ${e.at}`);
            } else {
              console.log(
                `    best ${e.from ? e.from.slice(0, 8) : "∅"} → ${e.to.slice(0, 8)} @ ${e.at}`,
              );
            }
          }
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  // ── render-report ────────────────────────────────────────────────────────
  refine
    .command("render-report")
    .description(
      "Render a canonical markdown Evidence Report to self-contained HTML (deterministic)",
    )
    .argument("<report.md>", "Path to the canonical markdown Skill Refiner Evidence Report")
    .option("--output <path>", "Write the HTML to <path> (default: stdout)")
    .action((reportPath: string, opts: { output?: string }) => {
      try {
        const md = readFileSync(resolve(reportPath), "utf8");
        const html = renderReportHtml(md);
        if (opts.output) {
          const out = resolve(opts.output);
          writeFileSync(out, html);
          console.log(`Rendered ${reportPath} → ${out}`);
        } else {
          process.stdout.write(html);
        }
      } catch (err) {
        if (err instanceof ReportRenderError) {
          fail(`report render failed (non-conforming markdown): ${err.message}`);
        }
        fail(err instanceof Error ? err.message : String(err));
      }
    });
}
