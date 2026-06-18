/**
 * `j-rig refine` command group — the 5 Skill Refiner CLI commands (plan 027 § 4
 * Phase A build-order step 7; "thin shim over orchestrator").
 *
 *   j-rig refine bootstrap <skill-dir>   — synthesize a held-out eval set
 *   j-rig refine score <skill-dir>       — delegate scoring to `j-rig eval`
 *   j-rig refine propose <skill-dir>     — propose a bounded edit (tiered model)
 *   j-rig refine apply <skill-dir>       — apply a stored proposal → new version
 *   j-rig refine status <skill-id>       — show the refiner store / event log
 *
 * The command group is BUILT here, in the `@j-rig/refiner` package, so the
 * orchestration logic ships with the refiner — the only edit in `@j-rig/cli` is a
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  makeSkillDoc,
  bootstrap,
  applyEdit,
  type SkillDoc,
  type EditProposal,
} from "@j-rig/refiner-core";
import { RefinerStore } from "./store.js";
import { score, createSubprocessEvalRunner, type ScoreModelTier } from "./score.js";
import { propose, AnthropicCompletionClient, type ProposeModelTier } from "./propose.js";
import {
  NaiveInContextStrategy,
  SkillOptStyleStrategy,
  type RefinerStrategy,
} from "@j-rig/refiner-core";

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
 * @param program        The j-rig CLI program (from @j-rig/cli).
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
    .description("Score a skill by delegating to `j-rig eval` (haiku|sonnet)")
    .argument("<skill-dir>", "Path to the skill directory containing SKILL.md")
    .option("--eval-set <hash>", "Eval-set hash to score against (defaults to bootstrap)")
    .option("--model <tier>", "Scoring tier: haiku | sonnet (never opus)", "sonnet")
    .option("--json", "Output as JSON")
    .action(
      async (skillDir: string, opts: { evalSet?: string; model?: string; json?: boolean }) => {
        try {
          const tier = (opts.model ?? "sonnet") as ScoreModelTier;
          if (tier !== "haiku" && tier !== "sonnet") {
            fail(`--model must be haiku or sonnet (got '${opts.model}'); opus is validation-only`);
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
          const record = await score(doc, evalSet, runner, { skillDir, modelTier: tier });
          store.putScoreRecord(record);
          if (opts.json) {
            console.log(JSON.stringify(record, null, 2));
          } else {
            console.log(`Scored '${doc.skillId}' (tier ${tier})`);
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
    .description("Propose a bounded SKILL.md edit (tiered model; never opus)")
    .argument("<skill-dir>", "Path to the skill directory containing SKILL.md")
    .option("--strategy <id>", "Strategy: skill-opt-style | naive-in-context", "skill-opt-style")
    .option("--model <tier>", "Propose tier: haiku | sonnet (never opus)", "sonnet")
    .option("--json", "Output as JSON")
    .action(
      async (skillDir: string, opts: { strategy?: string; model?: string; json?: boolean }) => {
        try {
          const tier = (opts.model ?? "sonnet") as ProposeModelTier;
          if (tier !== "haiku" && tier !== "sonnet") {
            fail(`--model must be haiku or sonnet (got '${opts.model}'); opus is validation-only`);
          }
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey || apiKey.length < 8) {
            fail(
              "propose requires ANTHROPIC_API_KEY (set it, or call propose() with a mock client in tests)",
            );
          }
          const doc = loadSkillDoc(skillDir);
          const strategy = selectStrategy(opts.strategy);
          const store = storeFactory(process.cwd());
          store.putSkillDoc(doc);
          const client = new AnthropicCompletionClient({ apiKey });
          // No scored rollouts on the CLI path yet (harvest is wave 2+); the
          // strategies tolerate an empty rollout set (single-pass proposal).
          const proposal = await propose(strategy, { doc, rollouts: [] }, client, { tier });
          const hash = store.putEditProposal(proposal);
          if (opts.json) {
            console.log(JSON.stringify(proposal, null, 2));
          } else {
            console.log(`Proposed ${proposal.ops.length} op(s) for '${doc.skillId}'`);
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
}
