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

import type { SkillDoc, EvalSet, ScoreRecord, ScoreDimension } from "@intentsolutions/refiner-core";

/** Per-pass scoring tier. Opus is excluded by construction (AC-5). */
export type ScoreModelTier = "haiku" | "sonnet";

/** Result of running the evaluator: its exit code + captured stdout/stderr. */
export interface EvalRunnerResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** The j-rig eval invocation the runner should perform. */
export interface EvalInvocation {
  /** Absolute/relative path to the skill directory containing SKILL.md. */
  readonly skillDir: string;
  /** Model tier passed to `--models` (haiku|sonnet — never opus). */
  readonly modelTier: ScoreModelTier;
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
  readonly modelTier?: ScoreModelTier;
}

/**
 * Score a skill doc against an eval set by delegating to `j-rig eval`.
 *
 * @param doc      The skill version being scored (its hash anchors the record).
 * @param evalSet  The held-out set the score is "against" (its hash anchors it).
 * @param runner   The injected evaluator shell-out (default spawns j-rig).
 * @param opts     skillDir (the directory j-rig evals) + modelTier (default sonnet).
 * @returns A refiner-core ScoreRecord with the kernel-pinned `behavioral` dim
 *          mapped from j-rig's pass_rate, plus `pass_count` / `total` dims.
 * @throws ScoreAdapterError if the evaluator failed or emitted unparseable output.
 */
export async function score(
  doc: SkillDoc,
  evalSet: EvalSet,
  runner: EvalRunner,
  opts: ScoreOptions,
): Promise<ScoreRecord> {
  const modelTier: ScoreModelTier = opts.modelTier ?? "sonnet";
  const result = await runner.run({ skillDir: opts.skillDir, modelTier });

  if (result.exitCode !== 0) {
    throw new ScoreAdapterError(
      `j-rig eval exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`,
    );
  }

  const scoreCard = extractScoreCard(result.stdout, modelTier);
  return mapToScoreRecord(doc, evalSet, scoreCard);
}

/** The subset of `j-rig eval --json` output the refiner consumes. */
interface JRigScoreCard {
  readonly total_criteria: number;
  readonly passed: number;
  readonly pass_rate: number;
}

/**
 * Pull the per-model scoreCard out of `j-rig eval --json` output.
 *
 * `j-rig eval --json` prints `{ "<model>": { ..., "scoreCard": {...} } }` keyed
 * by model. We pick the entry for `modelTier`, or the sole entry if the key
 * differs (the OpenAI-compatible path substitutes a vendor model id for the
 * short alias — so a single-entry object is taken as-is).
 */
function extractScoreCard(stdout: string, modelTier: ScoreModelTier): JRigScoreCard {
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

  const card = picked.scoreCard as Record<string, unknown> | undefined;
  if (card === undefined) {
    throw new ScoreAdapterError(`j-rig eval result for '${modelTier}' had no scoreCard`);
  }

  const total = asNumber(card.total_criteria);
  const passed = asNumber(card.passed);
  // j-rig carries pass_rate, but recompute defensively when absent / malformed.
  const passRate =
    typeof card.pass_rate === "number" && Number.isFinite(card.pass_rate)
      ? card.pass_rate
      : total > 0
        ? passed / total
        : 0;
  return { total_criteria: total, passed, pass_rate: passRate };
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
  const n = Math.max(1, card.total_criteria);
  const p = clamp01(card.pass_rate);
  const behavioral: ScoreDimension = { value: p, variance: p * (1 - p), n };
  const passCount: ScoreDimension = { value: card.passed, variance: 0, n };

  return {
    skill: doc.hash,
    evalSet: evalSet.hash,
    behavioral,
    dimensions: {
      behavioral,
      pass_count: passCount,
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
      const { spawn } = await import("node:child_process");
      const command = opts.command ?? "j-rig";
      const baseArgs = opts.args ?? ["eval"];
      const args = [...baseArgs, invocation.skillDir, "--json", "--models", invocation.modelTier];
      return await new Promise<EvalRunnerResult>((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
          env: opts.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("error", (err: Error) => rejectPromise(new ScoreAdapterError(err.message)));
        child.on("close", (code: number | null) =>
          resolvePromise({ stdout, stderr, exitCode: code ?? 1 }),
        );
      });
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

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
