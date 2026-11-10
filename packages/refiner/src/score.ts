/**
 * score() adapter — delegate scoring to the existing j-rig evaluator (plan 027
 * § 4 Phase A build-order step 5; "Reuses existing infrastructure": the Phase A
 * library DELEGATES scoring to j-rig, it does NOT build a new scorer).
 *
 * The refiner does not re-implement the 7-layer judgment stack. It shells out to
 * the already-shipped `j-rig eval <skill-dir> --json` command, parses that
 * command's JSON, and maps the result into a `@intentsolutions/refiner-core` ScoreRecord
 * (the value type the acceptance gate consumes). This is the single integration
 * seam between the Refiner and J-Rig Skill Binary Eval.
 *
 * AC-5 (Huyen economics): per-pass scoring runs on `haiku | sonnet` only — never
 * opus. The modelTier type makes opus unrepresentable at this entry point; final
 * Opus validation is a separate `validate()` path (wave 2+).
 *
 * The shell-out boundary is INJECTED via {@link EvalRunner} so unit tests run
 * without invoking the real evaluator (no live model key, no subprocess).
 */

import type {
  SkillDoc,
  EvalSet,
  ScoreRecord,
  ScoreDimension,
  AdversarialEvalItem,
  ItemResult,
} from "@intentsolutions/refiner-core";
import { hashSkillDoc, hashValue, validateEvalSet } from "@intentsolutions/refiner-core";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Per-pass scoring model. On the Anthropic path a tier (`haiku`|`sonnet`; opus
 * excluded by construction, AC-5). On the OpenAI-compatible path a raw vendor
 * model id is passed through instead — the tier discipline is Anthropic-specific.
 */
export type ScoreModelTier = "haiku" | "sonnet";

/** Result of running the evaluator: its exit code + captured stdout/stderr. */
export interface EvalRunnerResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** The j-rig eval invocation the runner should perform. */
export interface EvalInvocation {
  /** Frozen, integrity-checked inputs; the directory is never their authority. */
  readonly doc: SkillDoc;
  readonly evalSet: EvalSet;
  /** Caller source-directory context; the default runner executes the frozen inputs below. */
  readonly skillDir: string;
  /**
   * Value forwarded to `--models`. On the Anthropic path this is the `haiku`|
   * `sonnet` tier; on the OpenAI-compatible path it is the raw vendor model id.
   */
  readonly modelTier: string;
  /**
   * Optional `--provider <name>` forwarded to `j-rig eval`. When set, eval
   * resolves that backend (deepseek/groq/nvidia/openai/minimax/anthropic/…) — the SAME provider
   * names this package's registry uses — so `refine score` and `j-rig eval` agree.
   */
  readonly provider?: string;
}

/**
 * Injectable shell-out boundary. The default impl spawns `j-rig eval ... --json`
 * as a child process; tests pass a deterministic fake that returns canned JSON.
 */
export interface EvalRunner {
  run(invocation: EvalInvocation): Promise<EvalRunnerResult>;
}

export class ScoreAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoreAdapterError";
  }
}

export interface ScoreOptions {
  readonly skillDir: string;
  /**
   * Model forwarded to `--models`: a `haiku`|`sonnet` tier (Anthropic path, the
   * default) OR a raw vendor model id (OpenAI-compatible path). Default `sonnet`.
   */
  readonly modelTier?: string;
  /**
   * Optional `--provider <name>` forwarded to `j-rig eval` so scoring runs on the
   * SAME backend propose() resolved (deepseek/groq/nvidia/openai/minimax/anthropic/…).
   */
  readonly provider?: string;
}

/**
 * Score a skill doc against an eval set by delegating to `j-rig eval`.
 *
 * @param doc      The skill version being scored (its hash anchors the record).
 * @param evalSet  The frozen items and explicit expectations actually executed.
 * @param runner   The injected evaluator shell-out (default spawns j-rig).
 * @param opts     skillDir + modelTier (default sonnet) + optional provider.
 * @returns A refiner-core ScoreRecord with the kernel-pinned `behavioral` dim
 *          mapped from the verified scorecard, plus the `pass_count` dimension.
 * @throws ScoreAdapterError if the evaluator failed or emitted unparseable output.
 */
export async function score(
  doc: SkillDoc,
  evalSet: EvalSet,
  runner: EvalRunner,
  opts: ScoreOptions,
): Promise<ScoreRecord> {
  return (await runScore(doc, evalSet, runner, opts, false)).record;
}

/** Fresh scoring evidence for quality-gated orchestration; aggregate-only output is refused. */
export interface ScoredEvaluation {
  readonly record: ScoreRecord;
  readonly itemResults: readonly ItemResult[];
  readonly judge: { readonly provider: string; readonly model: string };
}

export async function scoreWithEvidence(
  doc: SkillDoc,
  evalSet: EvalSet,
  runner: EvalRunner,
  opts: ScoreOptions,
): Promise<ScoredEvaluation> {
  const result = await runScore(doc, evalSet, runner, opts, true);
  // extractScoreCard requires complete item evidence on this path.
  return { record: result.record, itemResults: result.itemResults!, judge: result.judge! };
}

async function runScore(
  doc: SkillDoc,
  evalSet: EvalSet,
  runner: EvalRunner,
  opts: ScoreOptions,
  requireItemResults: boolean,
): Promise<{
  record: ScoreRecord;
  itemResults?: readonly ItemResult[];
  judge?: { provider: string; model: string };
}> {
  const { doc: frozenDoc, evalSet: frozenSet } = checkedInputs(doc, evalSet);
  const modelTier: string = opts.modelTier ?? "sonnet";
  const result = await runner.run({
    doc: frozenDoc,
    evalSet: frozenSet,
    skillDir: opts.skillDir,
    modelTier,
    ...(opts.provider ? { provider: opts.provider } : {}),
  });

  if (result.exitCode !== 0) {
    const output = parseLastJsonObject(result.stdout);
    const reason =
      output?.error === "Package integrity failed"
        ? "package integrity failed; check frozen SKILL.md metadata and file references"
        : result.exitCode === 2
          ? "provider infrastructure failure"
          : result.exitCode === 3
            ? "evaluation budget exhausted"
            : "evaluation failed";
    throw new ScoreAdapterError(
      `j-rig eval exited ${result.exitCode}: ${reason}; no ScoreRecord produced`,
    );
  }

  const scoreCard = extractScoreCard(result.stdout, modelTier, frozenSet, requireItemResults);
  return {
    record: mapToScoreRecord(frozenDoc, frozenSet, scoreCard),
    itemResults: scoreCard.itemResults,
    judge: scoreCard.judge,
  };
}

/** The subset of `j-rig eval --json` output the refiner consumes. */
interface JRigScoreCard {
  readonly total_criteria: number;
  readonly passed: number;
  readonly pass_rate: number;
  readonly itemResults?: readonly ItemResult[];
  readonly judge?: { provider: string; model: string };
}

/**
 * Pull the per-model scoreCard out of `j-rig eval --json` output.
 *
 * `j-rig eval --json` prints `{ "<model>": { ..., "scoreCard": {...} } }` keyed
 * by model. We pick the entry for `modelTier`, or the sole entry if the key
 * differs (the OpenAI-compatible path substitutes a vendor model id for the
 * short alias — so a single-entry object is taken as-is).
 */
function extractScoreCard(
  stdout: string,
  modelTier: string,
  evalSet: EvalSet,
  requireItemResults: boolean,
): JRigScoreCard {
  const expectedCount = evalSet.items.length;
  const json = parseLastJsonObject(stdout);
  if (json === null) {
    throw new ScoreAdapterError("j-rig eval produced no parseable JSON object on stdout");
  }

  const entries = Object.entries(json);
  if (entries.length === 0) {
    throw new ScoreAdapterError("j-rig eval JSON had no per-model results");
  }

  const picked =
    (json[modelTier] as Record<string, unknown> | undefined) ??
    (entries.length === 1 ? (entries[0][1] as Record<string, unknown>) : undefined);
  if (picked === undefined) {
    throw new ScoreAdapterError(
      `j-rig eval JSON had no result for model '${modelTier}' (keys: ${entries.map((e) => e[0]).join(", ")})`,
    );
  }

  if (picked === null || typeof picked !== "object" || Array.isArray(picked)) {
    throw new ScoreAdapterError("j-rig eval result is not an object");
  }
  if (
    picked.ground_truth !== true ||
    picked.evaluation_error !== undefined ||
    picked.gate_decision === "error"
  ) {
    throw new ScoreAdapterError("j-rig eval did not produce completed real-provider evidence");
  }
  const card = picked.scoreCard as Record<string, unknown> | undefined;
  if (card === undefined || card === null || typeof card !== "object" || Array.isArray(card)) {
    throw new ScoreAdapterError(`j-rig eval result for '${modelTier}' had no scoreCard`);
  }

  const total = card.total_criteria;
  const passed = card.passed;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total !== expectedCount ||
    total < 1 ||
    typeof passed !== "number" ||
    !Number.isSafeInteger(passed) ||
    passed < 0 ||
    passed > total
  ) {
    throw new ScoreAdapterError("j-rig eval scoreCard does not account for the frozen eval set");
  }
  const passRate = passed / total;
  if (
    card.pass_rate !== undefined &&
    (typeof card.pass_rate !== "number" ||
      !Number.isFinite(card.pass_rate) ||
      Math.abs(card.pass_rate - passRate) > Number.EPSILON * 4)
  ) {
    throw new ScoreAdapterError("j-rig eval scoreCard has an inconsistent pass_rate");
  }
  const adversarial = evalSet.items.some(
    (item) => (item as AdversarialEvalItem).adversarial === true,
  );
  if (picked.criterion_results === undefined && !adversarial && !requireItemResults) {
    return { total_criteria: total, passed, pass_rate: passRate };
  }
  const rows = picked.criterion_results;
  if (!Array.isArray(rows) || rows.length !== expectedCount) {
    throw new ScoreAdapterError("complete per-item verdict evidence is required");
  }
  const byCriterion = new Map<string, Record<string, unknown>>();
  for (const row of rows as unknown[]) {
    if (row === null || typeof row !== "object")
      throw new ScoreAdapterError("invalid per-item verdict");
    const value = row as Record<string, unknown>;
    if (typeof value.criterion_id !== "string" || byCriterion.has(value.criterion_id)) {
      throw new ScoreAdapterError("per-item criterion identities must be unique");
    }
    byCriterion.set(value.criterion_id, value);
  }
  const itemResults = evalSet.items.map((item, index) => {
    const row = byCriterion.get(`refiner-item-${index}`);
    if (
      !row ||
      row.test_case_id !== item.id ||
      typeof row.verdict !== "string" ||
      !["yes", "no", "unsure"].includes(row.verdict)
    ) {
      throw new ScoreAdapterError("per-item verdict does not match the frozen criterion and case");
    }
    return { itemId: item.id, passed: row.verdict === "yes" };
  });
  if (itemResults.filter((item) => item.passed).length !== passed) {
    throw new ScoreAdapterError("per-item verdicts disagree with the aggregate scorecard");
  }
  if (
    requireItemResults &&
    (typeof picked.judge_provider !== "string" ||
      !picked.judge_provider.trim() ||
      typeof picked.judge_model !== "string" ||
      !picked.judge_model.trim())
  )
    throw new ScoreAdapterError("judge identity is required for calibrated scoring evidence");
  const judge =
    typeof picked.judge_provider === "string" && typeof picked.judge_model === "string"
      ? { provider: picked.judge_provider, model: picked.judge_model }
      : undefined;
  return { total_criteria: total, passed, pass_rate: passRate, itemResults, judge };
}

/**
 * Map a j-rig scoreCard into a refiner-core ScoreRecord.
 *
 * `behavioral` is the kernel-pinned Pareto-dominant dimension: its `value` is the
 * pass_rate, its `n` is the criteria count, and its `variance` is the
 * Bernoulli-proportion variance p(1-p) (the natural variance of a pass/fail
 * proportion — feeds the acceptance gate's significance test). `pass_count` is a
 * deterministic companion dim (variance 0) so the record is multi-dimensional
 * (Goodhart-resistant per AC-3), never a bare scalar.
 */
function mapToScoreRecord(doc: SkillDoc, evalSet: EvalSet, card: JRigScoreCard): ScoreRecord {
  const n = card.total_criteria;
  const p = card.pass_rate;
  const behavioral: ScoreDimension = { value: p, variance: p * (1 - p), n };
  const passCount: ScoreDimension = { value: card.passed, variance: 0, n };
  const adversarialIds = new Set(
    evalSet.items
      .filter((item) => (item as AdversarialEvalItem).adversarial === true)
      .map((item) => item.id),
  );
  const adversarialResults =
    card.itemResults?.filter((item) => adversarialIds.has(item.itemId)) ?? [];
  const adversarialN = adversarialResults.length;
  const adversarialRate =
    adversarialN > 0 ? adversarialResults.filter((item) => item.passed).length / adversarialN : 0;

  return {
    skill: doc.hash,
    evalSet: evalSet.hash,
    behavioral,
    dimensions: {
      behavioral,
      pass_count: passCount,
      ...(adversarialN > 0
        ? {
            adversarial_pass_rate: {
              value: adversarialRate,
              variance: adversarialRate * (1 - adversarialRate),
              n: adversarialN,
            },
          }
        : {}),
    },
  };
}

/**
 * Default {@link EvalRunner}: spawn `j-rig eval <skillDir> --json --models <tier>`
 * as a child process and capture stdout/stderr. Imported through a thin seam so
 * the package's non-spawning path (and the whole test suite) never touches
 * `node:child_process`.
 */
export function createSubprocessEvalRunner(
  opts: { command?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {},
): EvalRunner {
  return {
    async run(invocation: EvalInvocation): Promise<EvalRunnerResult> {
      const { doc, evalSet } = checkedInputs(invocation.doc, invocation.evalSet);
      const { spawn } = await import("node:child_process");
      const root = await mkdtemp(join(tmpdir(), "j-rig-refiner-score-"));
      try {
        const skillDir = join(root, doc.skillId);
        await mkdir(skillDir, { mode: 0o700 });
        await writeFile(join(skillDir, "SKILL.md"), doc.text, { mode: 0o600 });
        const specPath = join(root, "eval-spec.json");
        // JSON is valid YAML. One independently judged criterion per frozen item.
        const spec = {
          spec_version: "1.0",
          skill_name: doc.skillId,
          description: `Frozen Refiner eval set ${evalSet.hash}`,
          models: [invocation.modelTier],
          criteria: evalSet.items.map((item, i) => ({
            id: `refiner-item-${i}`,
            description: item.expectation,
            method: "judge",
            judge_prompt: item.expectation,
          })),
          test_cases: evalSet.items.map((item, i) => ({
            id: item.id,
            description: `Frozen eval item ${item.id}`,
            tier: "core",
            prompt: item.prompt,
            criteria_ids: [`refiner-item-${i}`],
          })),
        };
        await writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
        const command = opts.command ?? "j-rig";
        const baseArgs = opts.args ?? ["eval"];
        const args = [
          ...baseArgs,
          skillDir,
          "--json",
          "--models",
          invocation.modelTier,
          "--spec",
          specPath,
          "--no-trigger",
          "--db",
          join(root, "evaluation.db"),
        ];
        if (invocation.provider) args.push("--provider", invocation.provider);
        return await new Promise<EvalRunnerResult>((resolvePromise, rejectPromise) => {
          const child = spawn(command, args, {
            env: opts.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
          child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
          child.on("error", (error: NodeJS.ErrnoException) => {
            const code = [
              "ENOENT",
              "EACCES",
              "ENOEXEC",
              "EMFILE",
              "ENFILE",
              "ENOMEM",
              "EAGAIN",
            ].includes(error.code ?? "")
              ? ` (${error.code})`
              : "";
            rejectPromise(new ScoreAdapterError(`could not start j-rig eval${code}`));
          });
          child.on("close", (code: number | null) =>
            resolvePromise({ stdout, stderr, exitCode: code ?? 1 }),
          );
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse the first balanced JSON object on stdout. In `--json` mode the eval
 * command prints exactly one object; scanning from the first `{` to its matching
 * `}` tolerates a benign prefix without depending on the object being the whole
 * stream. Mirrors refiner-core's `extractJsonObject` scan discipline.
 */
function parseLastJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Validate and snapshot inputs before any evaluator I/O. */
export function checkedInputs(
  doc: SkillDoc,
  evalSet: EvalSet,
): { doc: SkillDoc; evalSet: EvalSet } {
  if (typeof doc.text !== "string" || hashSkillDoc(doc.text) !== doc.hash) {
    throw new ScoreAdapterError("skill document hash does not match its content");
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(doc.skillId)) {
    throw new ScoreAdapterError("skill id must be a kebab-case slug");
  }
  try {
    validateEvalSet(evalSet);
  } catch {
    throw new ScoreAdapterError("invalid frozen eval set");
  }
  if (doc.skillId !== evalSet.skillId) {
    throw new ScoreAdapterError("skill and eval-set identity mismatch");
  }
  // Preserve the existing bootstrap hash preimage (lineageId is metadata).
  const { skillId, source, items, evalSetVersion, lineageParent, refreshDueAt } = evalSet;
  if (
    hashValue({ skillId, source, items, evalSetVersion, lineageParent, refreshDueAt }) !==
    evalSet.hash
  ) {
    throw new ScoreAdapterError("eval-set hash does not match its content");
  }
  const ids = new Set<string>();
  for (const item of items) {
    const adversarial = (item as AdversarialEvalItem).adversarial;
    if (adversarial !== undefined && typeof adversarial !== "boolean") {
      throw new ScoreAdapterError("adversarial item flags must be boolean");
    }
    if (ids.has(item.id) || !item.prompt.trim()) {
      throw new ScoreAdapterError("eval-set items must have unique ids and non-empty prompts");
    }
    ids.add(item.id);
    if (!item.expectation?.trim()) {
      throw new ScoreAdapterError(
        "each eval item needs an explicit expected-behavior criterion before scoring",
      );
    }
  }
  return { doc: { ...doc }, evalSet: structuredClone(evalSet) };
}
