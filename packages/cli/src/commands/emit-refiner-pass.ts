/**
 * `j-rig emit-refiner-pass` — the authoring-chamber sibling of `emit-evidence`.
 *
 * Where `emit-evidence` wraps a **gate-result/v1** verdict (an EVAL verdict) into
 * a signed in-toto Statement, this command wraps a **skill-refiner-pass/v1**
 * accept-record (the Skill Refiner's ACCEPT decision over a SkillVersion) into
 * the exact same envelope shape. It is the structural parallel of emit-evidence,
 * for the refiner's accept-decision output instead of eval verdicts.
 *
 * Predicate URI: https://evals.intentsolutions.io/skill-refiner-pass/v1
 * (minted by Class-1 ADR DR-082, corrected in place by DR-085; runs
 * `sigstore_staging` until the four DR-082 Q3 production triggers hold). The URI
 * is emitted ONLY from the kernel constant `SKILL_REFINER_PASS_V1_URI`
 * (@intentsolutions/core) — never hardcoded here.
 *
 * ── Fail-closed emission ──
 * The predicate body is validated against the kernel's canonical Zod validator
 * `SkillRefinerPassV1Schema` (@intentsolutions/core/validators/v1/skill-refiner-pass-v1)
 * BEFORE anything is emitted. That validator enforces:
 *   - additionalProperties: false (`.strict()`),
 *   - alpha ∈ (0, 1),
 *   - the DR-085 D5 accept invariant (verdict === 'accept' ⇒ EVERY
 *     named_dimension_deltas[].non_regressed === true),
 *   - UUIDv7 / sha256-prefixed / kebab-slug primitive shapes.
 * A single violation THROWS — we never emit an invalid or placeholder row.
 *
 * ── Subject↔body binding (DR-085 D4 / DR-082 Q4) ──
 * The in-toto Statement's `subject[].digest.sha256` MUST equal the body's
 * `result_snapshot_hash` WITHOUT the `sha256:` prefix (the POST-EDIT output is
 * the artifact the pass attests — the authoring analogue of gate-result/v1's
 * input_hash === subject digest binding). We construct the subject from
 * `result_snapshot_hash` so this holds by construction.
 *
 * ── Input shape (the accept DETERMINANTS, DR-082 Q2) ──
 * A refiner accept-record is the union of the refiner-core acceptance-gate
 * verdict and the provenance the verdict was derived against — the fields a
 * verifier needs to independently re-derive the accept decision. The raw
 * `AcceptResult` from `@j-rig/refiner-core` (`{accepted:true}` / `{accepted:false,
 * reason}`) is only the bare verdict; the full determinant set (SkillVersion ids,
 * pre/post snapshot hashes, per-dimension deltas, eval-set ref, alpha,
 * refiner_strategy_id) lives in the surrounding refiner run context. This command
 * consumes that full record as a JSON object (stdin / --input) OR builds it from
 * direct-mode flags for the small scalar fields.
 *
 * Two input modes (mirrors emit-evidence):
 *
 *   1. Pipeline mode (stdin / --input):
 *        cat accept-record.json | j-rig emit-refiner-pass
 *      Reads a JSON object carrying the skill-refiner-pass/v1 determinants.
 *      Accepts either snake_case (predicate-body field names) or the
 *      refiner-core camelCase surface for convenience.
 *
 *   2. Direct mode (--verdict, --skill-version-id, ...):
 *        j-rig emit-refiner-pass --verdict accept \
 *          --refiner-strategy-id naive-in-context \
 *          --skill-version-id <uuidv7> --parent-version-id <uuidv7|null> \
 *          --source-snapshot-hash sha256:... --result-snapshot-hash sha256:... \
 *          --edit-proposal-hash sha256:... \
 *          --eval-set-hash sha256:... --eval-set-version 1.0.0 \
 *          --eval-set-lineage-id <uuidv7> \
 *          --behavioral-delta 0.12 --alpha 0.05 \
 *          --reason significant-behavioral-improvement \
 *          --named-dimension readability:0.01:true
 *
 * Output:
 *   stdout = the in-toto Statement JSON (single line, ready for piping to a
 *            signer or a Bundle accumulator) — or the predicate body alone with
 *            --predicate-body-only.
 *   stderr = log lines.
 *
 * Exit codes:
 *   0  Statement emitted
 *   1  input malformed / missing required fields / kernel validation failed
 *   2  --output write failed
 */
import type { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  SkillRefinerPassV1Schema,
  SKILL_REFINER_PASS_V1_URI,
} from "@intentsolutions/core/validators/v1/skill-refiner-pass-v1";

/** in-toto Statement v1 type URI — same envelope as gate-result/v1 (DR-082 Q4). */
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1" as const;

interface NamedDimensionDeltaInput {
  id: string;
  delta: number;
  non_regressed: boolean;
}

interface EmitRefinerPassOptions {
  input?: string;
  output?: string;
  subjectName?: string;
  predicateBodyOnly?: boolean;
  // Direct-mode flags (predicate-body field names)
  verdict?: string;
  reason?: string[];
  refinerStrategyId?: string;
  skillVersionId?: string;
  parentVersionId?: string;
  sourceSnapshotHash?: string;
  resultSnapshotHash?: string;
  editProposalHash?: string;
  evalSetHash?: string;
  evalSetVersion?: string;
  evalSetLineageId?: string;
  behavioralDelta?: string;
  namedDimension?: string[];
  alpha?: string;
  testStatisticKind?: string;
  costRecordRef?: string;
  replayFidelityLevel?: string;
  signingDowngradeReason?: string;
}

/** The validated predicate body type (kernel-inferred). */
type SkillRefinerPassV1Body = z.infer<typeof SkillRefinerPassV1Schema>;

/** Default subject name when none is supplied. */
const DEFAULT_SUBJECT_NAME = "skill-version" as const;

/** Default statistical-test family — the only value v1 accepts (kernel const). */
const DEFAULT_TEST_STATISTIC_KIND = "one-sided-z" as const;

export function registerEmitRefinerPassCommand(program: Command): void {
  program
    .command("emit-refiner-pass")
    .description(
      "Wrap a Skill Refiner accept-record into an in-toto Statement v1 carrying the kernel skill-refiner-pass/v1 predicate (https://evals.intentsolutions.io/skill-refiner-pass/v1)",
    )
    .option("--input <path>", "Read the refiner accept-record JSON from <path> instead of stdin")
    .option("--output <path>", "Write the Statement to <path> instead of stdout")
    .option(
      "--subject-name <name>",
      `Subject name for the in-toto Statement (default: "${DEFAULT_SUBJECT_NAME}")`,
    )
    .option(
      "--predicate-body-only",
      "Emit ONLY the validated predicate body instead of the full in-toto Statement (parity with emit-evidence).",
    )
    // Direct-mode flags (predicate-body field names)
    .option("--verdict <v>", "Direct mode: accept|reject")
    .option(
      "--reason <code>",
      "Direct mode: structured reason code (repeatable; at least one — the row is emitted on a real verdict)",
      collect,
      [] as string[],
    )
    .option(
      "--refiner-strategy-id <id>",
      "Direct mode: identifier of the RefinerStrategy that produced this verdict (mechanism-traceable; DR-028 CISO binding)",
    )
    .option("--skill-version-id <uuidv7>", "Direct mode: UUIDv7 of the accepted SkillVersion")
    .option(
      "--parent-version-id <uuidv7|null>",
      "Direct mode: UUIDv7 of the parent SkillVersion, or the literal 'null' for a root (DR-085 D3 nullable)",
    )
    .option(
      "--source-snapshot-hash <h>",
      "Direct mode: sha256:<64-hex> of the PRE-EDIT input snapshot (DR-085 D4)",
    )
    .option(
      "--result-snapshot-hash <h>",
      "Direct mode: sha256:<64-hex> of the POST-EDIT output snapshot — the artifact the pass attests; becomes the in-toto subject digest (DR-085 D4)",
    )
    .option(
      "--edit-proposal-hash <h>",
      "Direct mode: sha256:<64-hex> of the EditProposal that earned the pass",
    )
    .option("--eval-set-hash <h>", "Direct mode: sha256:<64-hex> of the frozen eval-set content")
    .option("--eval-set-version <ver>", "Direct mode: frozen eval-set version (minLength 1)")
    .option("--eval-set-lineage-id <uuidv7>", "Direct mode: UUIDv7 of the eval-set lineage")
    .option(
      "--behavioral-delta <n>",
      "Direct mode: observed delta on the behavioral dimension (number)",
    )
    .option(
      "--named-dimension <id:delta:non_regressed>",
      "Direct mode: a named-dimension delta as 'id:delta:non_regressed' (repeatable; e.g. readability:0.01:true)",
      collect,
      [] as string[],
    )
    .option("--alpha <n>", "Direct mode: significance level α ∈ (0, 1) (default: 0.05)")
    .option(
      "--test-statistic-kind <k>",
      `Direct mode: statistical-test family (default: "${DEFAULT_TEST_STATISTIC_KIND}"; the only v1 value)`,
    )
    .option("--cost-record-ref <uuidv7>", "Direct mode: OPTIONAL FK → CostRecord.id")
    .option(
      "--replay-fidelity-level <lvl>",
      "Direct mode: OPTIONAL replay-fidelity claim (RF-0..RF-4)",
    )
    .option(
      "--signing-downgrade-reason <r>",
      "Direct mode: OPTIONAL structured reason, present ONLY on a signing-mode-downgraded row",
    )
    .action(async (opts: EmitRefinerPassOptions) => {
      try {
        const rawBody = await buildPredicateBody(opts);

        // Fail-closed: validate against the kernel's canonical Zod validator.
        // This enforces the determinant-only shape (.strict()), alpha ∈ (0,1),
        // primitive formats, AND the DR-085 D5 accept invariant. Any violation
        // throws — we NEVER emit an invalid or placeholder row.
        const parsed = SkillRefinerPassV1Schema.safeParse(rawBody);
        if (!parsed.success) {
          throw new Error(
            `skill-refiner-pass/v1 predicate body failed kernel validation:\n${formatZodError(parsed.error)}`,
          );
        }
        const body: SkillRefinerPassV1Body = parsed.data;

        if (opts.predicateBodyOnly) {
          writeOut(JSON.stringify(body), opts);
          process.exit(0);
        }

        const statement = composeRefinerPassStatement(
          body,
          opts.subjectName ?? DEFAULT_SUBJECT_NAME,
        );
        writeOut(JSON.stringify(statement), opts);
        process.exit(0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`j-rig emit-refiner-pass: ${msg}\n`);
        process.exit(1);
      }
    });
}

/** Commander repeatable-flag accumulator. */
function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

/**
 * Compose the in-toto Statement v1 wrapping the validated predicate body.
 *
 * The predicate URI comes ONLY from the kernel constant (never a string
 * literal). The subject digest binds to `result_snapshot_hash` sans the
 * `sha256:` prefix (DR-085 D4 / DR-082 Q4) — the POST-EDIT output is the
 * artifact being attested.
 */
export function composeRefinerPassStatement(
  body: SkillRefinerPassV1Body,
  subjectName: string,
): {
  _type: typeof IN_TOTO_STATEMENT_V1;
  subject: { name: string; digest: { sha256: string } }[];
  predicateType: typeof SKILL_REFINER_PASS_V1_URI;
  predicate: SkillRefinerPassV1Body;
} {
  const digest = stripSha256Prefix(body.result_snapshot_hash);
  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{ name: subjectName, digest: { sha256: digest } }],
    predicateType: SKILL_REFINER_PASS_V1_URI,
    predicate: body,
  };
}

/** Strip the `sha256:` prefix from a prefixed digest for the in-toto subject. */
function stripSha256Prefix(h: string): string {
  return h.startsWith("sha256:") ? h.slice("sha256:".length) : h;
}

function writeOut(content: string, opts: EmitRefinerPassOptions): void {
  if (opts.output) {
    const outAbs = resolve(opts.output);
    try {
      if (!existsSync(dirname(outAbs))) mkdirSync(dirname(outAbs), { recursive: true });
      writeFileSync(outAbs, content + "\n");
    } catch (err) {
      // Write failures use exit code 2 (distinct from validation-failure 1).
      process.stderr.write(
        `j-rig emit-refiner-pass: failed to write ${outAbs}: ${(err as Error).message}\n`,
      );
      process.exit(2);
    }
    process.stderr.write(`emit-refiner-pass: wrote ${outAbs}\n`);
  } else {
    process.stdout.write(content + "\n");
  }
}

/**
 * Build the raw predicate body from either pipeline input or direct-mode flags.
 * The result is UNVALIDATED — the caller runs it through the kernel validator.
 */
async function buildPredicateBody(opts: EmitRefinerPassOptions): Promise<Record<string, unknown>> {
  // Direct mode: presence of any of the discriminating scalar flags activates it.
  if (
    opts.verdict ||
    opts.skillVersionId ||
    opts.resultSnapshotHash ||
    opts.sourceSnapshotHash ||
    opts.evalSetHash
  ) {
    return buildFromDirectFlags(opts);
  }

  // Pipeline mode: read a JSON object from --input or stdin.
  const raw = await readInputJson(opts.input);
  if (!raw || raw.trim() === "") {
    throw new Error(
      "no input received — pipe a refiner accept-record JSON object on stdin OR pass --input <path> OR use direct-mode flags (--verdict, --skill-version-id, ...)",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`input is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("refiner accept-record must be a JSON object");
  }
  return normalizeRecord(parsed as Record<string, unknown>);
}

/**
 * The full set of input keys `normalizeRecord` recognizes — both the snake_case
 * predicate-body names and their camelCase refiner-core aliases. Any input key
 * NOT in this set is refused (see below): silently dropping an unknown key would
 * mask a misspelled required field (e.g. `skill_ver_id` for `skill_version_id`)
 * and weaken the fail-closed guarantee. The kernel `.strict()` validator only
 * sees the normalized snake_case object, so unknown-key rejection must happen HERE.
 */
const RECOGNIZED_INPUT_KEYS: ReadonlySet<string> = new Set([
  // snake_case (predicate-body field names)
  "verdict",
  "reason",
  "refiner_strategy_id",
  "skill_version_id",
  "parent_version_id",
  "source_snapshot_hash",
  "result_snapshot_hash",
  "eval_set_ref",
  "edit_proposal_hash",
  "behavioral_delta",
  "named_dimension_deltas",
  "alpha",
  "test_statistic_kind",
  "cost_record_ref",
  "replay_fidelity_level",
  "signing_downgrade_reason",
  // camelCase (refiner-core surface aliases)
  "refinerStrategyId",
  "skillVersionId",
  "parentVersionId",
  "sourceSnapshotHash",
  "resultSnapshotHash",
  "evalSetRef",
  "editProposalHash",
  "behavioralDelta",
  "namedDimensionDeltas",
  "testStatisticKind",
  "costRecordRef",
  "replayFidelityLevel",
  "signingDowngradeReason",
]);

/**
 * Normalize a pipeline record: accept the snake_case predicate-body field names
 * directly, and also translate the refiner-core camelCase surface as a
 * convenience so an accept-record produced by the refiner can be piped in
 * without manual key renaming. snake_case keys always win when both are present.
 *
 * Fail-closed on unknown keys: an input key we don't recognize is REFUSED rather
 * than silently dropped, so a typo'd field name never masquerades as an absent
 * required field.
 */
function normalizeRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const unknown = Object.keys(rec).filter((k) => !RECOGNIZED_INPUT_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `refiner accept-record has unrecognized field(s): ${unknown.join(", ")}. ` +
        `Unknown keys are refused (never silently dropped) so a typo cannot mask a required field. ` +
        `Valid keys are the skill-refiner-pass/v1 predicate-body fields (snake_case) or their refiner-core camelCase aliases.`,
    );
  }

  const pick = (snake: string, camel: string): unknown =>
    rec[snake] !== undefined ? rec[snake] : rec[camel];

  const out: Record<string, unknown> = {
    verdict: pick("verdict", "verdict"),
    reason: pick("reason", "reason"),
    refiner_strategy_id: pick("refiner_strategy_id", "refinerStrategyId"),
    skill_version_id: pick("skill_version_id", "skillVersionId"),
    parent_version_id: pick("parent_version_id", "parentVersionId"),
    source_snapshot_hash: pick("source_snapshot_hash", "sourceSnapshotHash"),
    result_snapshot_hash: pick("result_snapshot_hash", "resultSnapshotHash"),
    eval_set_ref: pick("eval_set_ref", "evalSetRef"),
    edit_proposal_hash: pick("edit_proposal_hash", "editProposalHash"),
    behavioral_delta: pick("behavioral_delta", "behavioralDelta"),
    named_dimension_deltas: pick("named_dimension_deltas", "namedDimensionDeltas"),
    alpha: pick("alpha", "alpha"),
    test_statistic_kind: pick("test_statistic_kind", "testStatisticKind"),
  };

  // Optionals — only set the key when present (exactOptionalPropertyTypes-safe;
  // absent optionals must not appear as `undefined` on the strict body).
  const costRecordRef = pick("cost_record_ref", "costRecordRef");
  if (costRecordRef !== undefined) out.cost_record_ref = costRecordRef;
  const replayFidelity = pick("replay_fidelity_level", "replayFidelityLevel");
  if (replayFidelity !== undefined) out.replay_fidelity_level = replayFidelity;
  const downgradeReason = pick("signing_downgrade_reason", "signingDowngradeReason");
  if (downgradeReason !== undefined) out.signing_downgrade_reason = downgradeReason;

  // Default test_statistic_kind to the sole v1 value when omitted.
  if (out.test_statistic_kind === undefined) out.test_statistic_kind = DEFAULT_TEST_STATISTIC_KIND;

  // Strip any keys that resolved to undefined so the kernel .strict() validator
  // reports "required" for a genuinely-absent field rather than "invalid type".
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

function buildFromDirectFlags(opts: EmitRefinerPassOptions): Record<string, unknown> {
  const evalSetRef =
    opts.evalSetHash || opts.evalSetVersion || opts.evalSetLineageId
      ? {
          hash: opts.evalSetHash,
          version: opts.evalSetVersion,
          lineage_id: opts.evalSetLineageId,
        }
      : undefined;

  const out: Record<string, unknown> = {
    verdict: opts.verdict,
    reason: opts.reason && opts.reason.length > 0 ? opts.reason : undefined,
    refiner_strategy_id: opts.refinerStrategyId,
    skill_version_id: opts.skillVersionId,
    parent_version_id: parseParentVersionId(opts.parentVersionId),
    source_snapshot_hash: opts.sourceSnapshotHash,
    result_snapshot_hash: opts.resultSnapshotHash,
    eval_set_ref: evalSetRef,
    edit_proposal_hash: opts.editProposalHash,
    behavioral_delta: parseNumberFlag(opts.behavioralDelta, "--behavioral-delta"),
    named_dimension_deltas: parseNamedDimensions(opts.namedDimension ?? []),
    alpha: opts.alpha !== undefined ? parseNumberFlag(opts.alpha, "--alpha") : 0.05,
    test_statistic_kind: opts.testStatisticKind ?? DEFAULT_TEST_STATISTIC_KIND,
  };

  if (opts.costRecordRef !== undefined) out.cost_record_ref = opts.costRecordRef;
  if (opts.replayFidelityLevel !== undefined) out.replay_fidelity_level = opts.replayFidelityLevel;
  if (opts.signingDowngradeReason !== undefined)
    out.signing_downgrade_reason = opts.signingDowngradeReason;

  // Remove undefineds so the kernel validator emits clean "required" errors.
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

/**
 * Parse --parent-version-id. The literal 'null' (case-insensitive) maps to JS
 * null (a root SkillVersion, DR-085 D3). An absent flag also maps to null so the
 * required-but-nullable key is always present. A UUID string passes through.
 */
function parseParentVersionId(v: string | undefined): string | null {
  if (v === undefined || v.toLowerCase() === "null") return null;
  return v;
}

function parseNumberFlag(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw new Error(`${flag} must be a number, got '${v}'`);
  }
  return n;
}

/**
 * Parse repeatable --named-dimension 'id:delta:non_regressed' entries into the
 * predicate's NamedDimensionDelta[] shape. The id may itself contain no colons
 * (kebab-slug), so we split on the LAST two colons.
 */
function parseNamedDimensions(entries: string[]): NamedDimensionDeltaInput[] {
  return entries.map((entry) => {
    const lastColon = entry.lastIndexOf(":");
    const secondLastColon = entry.lastIndexOf(":", lastColon - 1);
    if (lastColon === -1 || secondLastColon === -1) {
      throw new Error(
        `--named-dimension must be 'id:delta:non_regressed' (e.g. readability:0.01:true), got '${entry}'`,
      );
    }
    const id = entry.slice(0, secondLastColon);
    const deltaStr = entry.slice(secondLastColon + 1, lastColon);
    const nonRegressedStr = entry.slice(lastColon + 1);
    const delta = Number(deltaStr);
    if (Number.isNaN(delta)) {
      throw new Error(`--named-dimension delta must be a number, got '${deltaStr}' in '${entry}'`);
    }
    if (nonRegressedStr !== "true" && nonRegressedStr !== "false") {
      throw new Error(
        `--named-dimension non_regressed must be 'true' or 'false', got '${nonRegressedStr}' in '${entry}'`,
      );
    }
    return { id, delta, non_regressed: nonRegressedStr === "true" };
  });
}

/** Format a ZodError into a compact multi-line message. */
function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

async function readInputJson(inputPath?: string): Promise<string> {
  if (inputPath) {
    return readFileSync(resolve(inputPath), "utf-8");
  }
  if (process.stdin.isTTY) {
    return "";
  }
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
    process.stdin.on("end", () => resolveP(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", rejectP);
  });
}
