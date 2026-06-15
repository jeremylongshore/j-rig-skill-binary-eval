/**
 * `j-rig emit-evidence` — v2.0.0 (DR-018, iaj-E02).
 *
 * Wraps a gate-result envelope (or builds one from flags) into an in-toto
 * Statement v1 carrying the gate-result/v1 predicate URI.
 *
 * Breaking changes from v1:
 *   - --result now takes lowercase values: pass|fail|advisory|error (was PASS/FAIL/...)
 *   - --result NOT_APPLICABLE is still accepted for backward-compat but routes
 *     to coverage.dimensions_skipped (the dimension is added to skipped, a
 *     `pass` decision is emitted). This preserves composability per DR-018 §279.
 *   - NEW required flags (direct mode): --gate-name, --gate-version,
 *     --coverage-evaluated (repeatable), --policy-ref
 *   - --gate-reason (repeatable) replaces providing reasons inline; at least
 *     one reason is expected for non-pass decisions.
 *   - timestamp field → evaluated_at (same ISO format, now with offset)
 *
 * Two input modes:
 *
 *   1. Pipeline mode (stdin / --input):
 *        echo '{"gate_id":"...","gate_decision":"pass",...}' | j-rig emit-evidence
 *      Reads a partial gate-result envelope (the same shape audit-harness
 *      gates emit via --json) and augments it with evaluated_at/runner/commit_sha.
 *
 *   2. Direct mode (--gate-id, --gate-decision, ...):
 *        j-rig emit-evidence --gate-id 'j-rig:server:MM-1' --gate-decision pass \
 *          --gate-name coverage-check --gate-version 2.0.0 \
 *          --gate-reason "all lines covered" \
 *          --coverage-evaluated lines --coverage-evaluated branches \
 *          --policy-ref sha256:abc...def:vitest.config.ts \
 *          --input-hash sha256:... --policy-hash sha256:...
 *
 * Output:
 *   stdout = the in-toto Statement JSON (single line, ready for piping to
 *            cosign attest-blob or to a Bundle accumulator)
 *   stderr = log lines
 *
 * Exit codes:
 *   0  Statement emitted
 *   1  input malformed or missing required fields
 *   2  --output write failed
 */
import type { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  composeStatement,
  serializeStatement,
  GateResultEnum,
  AdvisorySeverityEnum,
  type GateResult,
  type AdvisorySeverity,
  type ComposeStatementInput,
  type EvidenceStatement,
} from "@j-rig/core";

interface EmitEvidenceOptions {
  input?: string;
  output?: string;
  runnerVersion?: string;
  commitSha?: string;
  // Direct-mode flags (v2 field names)
  gateId?: string;
  gateDecision?: string;
  gateName?: string;
  gateVersion?: string;
  gateReason?: string[];
  coverageEvaluated?: string[];
  coverageSkipped?: string[];
  policyRef?: string;
  inputHash?: string;
  policyHash?: string;
  failureMode?: string;
  advisorySeverity?: string;
  metadata?: string;
  // Signing flags (cosign integration; see SPEC.md § 7)
  sign?: boolean;
  key?: string;
  keyless?: boolean;
  rekorUrl?: string | boolean; // boolean true when flag used without a value (Commander [url] form)
  predicateBodyOnly?: boolean;
  fullStatement?: boolean;
  cosignBin?: string;
  artifact?: string;
}

/**
 * Sentinel used internally when CLI receives --result NOT_APPLICABLE.
 * This is not a valid gate_decision; it routes to coverage.dimensions_skipped.
 */
const NOT_APPLICABLE_SENTINEL = "NOT_APPLICABLE" as const;

const DEFAULT_RUNNER_VERSION = "j-rig@0.0.0-dev"; // overridden when packaged

export function registerEmitEvidenceCommand(program: Command): void {
  program
    .command("emit-evidence")
    .description(
      "Wrap a gate-result envelope into a signed in-toto Statement v1 (https://evals.intentsolutions.io/gate-result/v1)",
    )
    .option("--input <path>", "Read gate-result JSON from <path> instead of stdin")
    .option("--output <path>", "Write Statement to <path> instead of stdout")
    .option(
      "--runner-version <ver>",
      'Override runner identifier (default: "j-rig@<package version>")',
    )
    .option("--commit-sha <sha>", "Override commit SHA (default: git rev-parse HEAD)")
    // Direct-mode flags (v2)
    .option("--gate-id <id>", "Direct mode: gate id (e.g. 'j-rig:server:MM-1')")
    .option(
      "--gate-decision <d>",
      "Direct mode: pass|fail|advisory|error (or NOT_APPLICABLE for backward-compat; routes to coverage.dimensions_skipped)",
    )
    .option(
      "--gate-name <name>",
      "Direct mode: gate name in lowercase kebab-case (e.g. 'coverage-check')",
    )
    .option("--gate-version <ver>", "Direct mode: gate SemVer (e.g. '2.0.0')")
    .option(
      "--gate-reason <reason>",
      "Direct mode: reason string (repeatable; at least one for non-pass decisions)",
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option(
      "--coverage-evaluated <dim>",
      "Direct mode: dimension that was evaluated (repeatable)",
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option(
      "--coverage-skipped <dim>",
      "Direct mode: dimension that was skipped / not applicable (repeatable)",
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option("--policy-ref <ref>", "Direct mode: policy reference sha256:<hex>:<path>")
    .option("--input-hash <h>", "Direct mode: sha256:<64-hex>")
    .option("--policy-hash <h>", "Direct mode: sha256:<64-hex>")
    .option("--failure-mode <m>", "Direct mode: failure_mode (when gate-decision=fail)")
    .option("--advisory-severity <s>", "Direct mode: info|warn|error (when gate-decision=advisory)")
    .option("--metadata <json>", "Direct mode: free-form metadata as a JSON object string")
    // --- Signing (cosign integration; SPEC.md § 7) ---
    .option(
      "--sign",
      "Sign the Statement via cosign (requires --key OR --keyless). Without this flag, emits unsigned Statement.",
    )
    .option("--key <ref>", "cosign key reference (file path, KMS URI, etc). Implies --sign.")
    .option(
      "--keyless",
      "cosign keyless signing via Fulcio OIDC (requires terminal). Implies --sign.",
    )
    .option(
      "--rekor-url [url]",
      "Push the signed attestation to Rekor at <url> (defaults to https://rekor.sigstore.dev when flag is used without a value). Implies --sign.",
    )
    .option(
      "--predicate-body-only",
      "Plain (unsigned) mode: emit ONLY the predicate body instead of the full v1 Statement. The signing path ALWAYS sends the predicate body to cosign (which wraps it in its own Statement envelope) unless --full-statement is given.",
    )
    .option(
      "--full-statement",
      "Signing mode: pass the full pre-formed in-toto Statement to cosign's --predicate instead of the predicate body. cosign attest-blob will then NEST it inside its own Statement (double-wrapped); only for consumers that expect the nested form.",
    )
    .option("--cosign-bin <path>", "Path to cosign binary (default: cosign on PATH).", "cosign")
    .option(
      "--artifact <path>",
      "Path to the artifact whose sha256 must equal predicate.input_hash. Required when --sign is requested so the DSSE envelope's subject digest is cryptographically bound to the gate's input. Without this, the link between attestation and artifact cannot be verified by standard tooling.",
    )
    .action(async (opts: EmitEvidenceOptions) => {
      try {
        const composed = await buildComposeInput(opts);
        const statement = composeStatement(composed);

        // OTel best-effort emission (mirrors audit-harness emit-evidence.sh)
        if (process.env.AUDIT_HARNESS_OTEL === "1" || process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
          const evt = {
            name: "agent.rollout.gate.evaluated",
            attributes: {
              "gate.id": composed.gateId,
              "gate.decision": composed.gateDecision,
              "gate.runner": composed.runner,
              "gate.commit_sha": composed.commitSha,
            },
            timestamp: statement.predicate.evaluated_at,
          };
          process.stderr.write(`[OTEL] ${JSON.stringify(evt)}\n`);
        }

        const wantsSigning =
          opts.sign === true ||
          opts.key !== undefined ||
          opts.keyless === true ||
          opts.rekorUrl !== undefined;

        if (!wantsSigning) {
          // Plain mode: emit the chosen shape.
          const out = opts.predicateBodyOnly
            ? JSON.stringify(statement.predicate)
            : serializeStatement(statement);
          writeOut(out, opts);
          process.exit(0);
        }

        // Signing mode: invoke cosign attest-blob over a synthetic blob whose
        // sha256 matches the predicate's input_hash.
        const exitCode = signAndEmit(statement, composed, opts);
        process.exit(exitCode);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`j-rig emit-evidence: ${msg}\n`);
        // Pre-write/validation failures always exit 1 regardless of --output.
        // signAndEmit's explicit 1/2/3 codes are left unchanged (P1 fix).
        process.exit(1);
      }
    });
}

function writeOut(content: string, opts: EmitEvidenceOptions): void {
  if (opts.output) {
    const outAbs = resolve(opts.output);
    if (!existsSync(dirname(outAbs))) mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, content + "\n");
    process.stderr.write(`emit-evidence: wrote ${outAbs}\n`);
  } else {
    process.stdout.write(content + "\n");
  }
}

/**
 * Sign the Statement via cosign and emit the resulting DSSE envelope.
 * Returns the desired process exit code.
 */
function signAndEmit(
  statement: EvidenceStatement,
  composed: ComposeStatementInput,
  opts: EmitEvidenceOptions,
): number {
  if (!opts.key && !opts.keyless) {
    process.stderr.write("j-rig emit-evidence: --sign requires --key <ref> OR --keyless\n");
    return 1;
  }

  if (opts.fullStatement && opts.predicateBodyOnly) {
    process.stderr.write(
      "j-rig emit-evidence: --full-statement and --predicate-body-only are mutually exclusive\n",
    );
    return 1;
  }

  // --artifact is required for signing — without the original bytes, the
  // DSSE envelope's subject digest cannot match predicate.input_hash and the
  // attestation cannot be verified by standard tooling. We refuse rather
  // than produce a misleading attestation.
  if (!opts.artifact) {
    process.stderr.write(
      "j-rig emit-evidence: --sign requires --artifact <path> pointing at the file whose sha256 equals predicate.input_hash. " +
        "Without --artifact the attestation's subject digest cannot match the predicate, breaking standard verification.\n",
    );
    return 1;
  }
  const artifactAbs = resolve(opts.artifact);
  if (!existsSync(artifactAbs)) {
    process.stderr.write(`j-rig emit-evidence: --artifact path does not exist: ${artifactAbs}\n`);
    return 1;
  }
  const artifactBytes = readFileSync(artifactAbs);
  const actualHash = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
  if (actualHash !== composed.inputHash) {
    process.stderr.write(
      `j-rig emit-evidence: --artifact sha256 mismatch:\n  computed: ${actualHash}\n  predicate.input_hash: ${composed.inputHash}\nThe artifact passed to --sign must be the exact file whose hash the gate recorded.\n`,
    );
    return 1;
  }

  // Normalize rekorUrl: --rekor-url with no value sets boolean true in Commander [url] form.
  // Default to the public Rekor instance when the flag is present but no URL given.
  const rekorUrlStr =
    opts.rekorUrl === true
      ? "https://rekor.sigstore.dev"
      : typeof opts.rekorUrl === "string"
        ? opts.rekorUrl
        : undefined;

  const tmp = mkdtempSync(join(tmpdir(), "j-rig-emit-evidence-"));
  try {
    // Predicate file: by default we send just the predicate body (cosign
    // wraps it in its own Statement envelope with our predicateType), so the
    // gate-result fields land at predicate.* where verifiers expect them.
    // --full-statement opts out to preserve a pre-formed Statement (which
    // cosign will then NEST — double-wrapped).
    const predicatePath = join(tmp, "predicate.json");
    const predicateContent = opts.fullStatement
      ? JSON.stringify(statement, null, 2)
      : JSON.stringify(statement.predicate, null, 2);
    writeFileSync(predicatePath, predicateContent);

    const sigPath = join(tmp, "attestation.sig");
    const args = [
      "attest-blob",
      "--predicate",
      predicatePath,
      "--type",
      "https://evals.intentsolutions.io/gate-result/v1",
      "--output-signature",
      sigPath,
      `--tlog-upload=${rekorUrlStr || opts.keyless ? "true" : "false"}`,
    ];
    if (opts.key) args.push("--key", opts.key);
    else if (opts.keyless) args.push("--yes"); // cosign keyless OIDC accept
    if (rekorUrlStr) args.push("--rekor-url", rekorUrlStr);
    args.push(artifactAbs);

    const cosignBin = opts.cosignBin ?? "cosign";
    const result = spawnSync(cosignBin, args, {
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    if (result.error) {
      process.stderr.write(
        `j-rig emit-evidence: failed to spawn cosign (${cosignBin}): ${result.error.message}\n`,
      );
      return 2;
    }
    if (result.status !== 0) {
      process.stderr.write(
        `j-rig emit-evidence: cosign signing failed (exit ${result.status}):\n${result.stderr.toString()}\n`,
      );
      return 3;
    }
    const sig = readFileSync(sigPath, "utf-8").trim();
    writeOut(sig, opts);
    process.stderr.write(
      `emit-evidence: signed envelope emitted${rekorUrlStr ? ` (Rekor: ${rekorUrlStr})` : ""}\n`,
    );
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function buildComposeInput(opts: EmitEvidenceOptions): Promise<ComposeStatementInput> {
  const runner = opts.runnerVersion ?? DEFAULT_RUNNER_VERSION;
  const commitSha = opts.commitSha ?? safeGitHead();

  // Direct mode: any of these flags being present activates direct mode.
  // Explicitly include --gate-name/--gate-version/--policy-ref so that
  // passing only one of the new-required flags does not fall through to
  // pipeline mode and block on stdin (nit fix).
  if (
    opts.gateId ||
    opts.gateDecision ||
    opts.gateName ||
    opts.gateVersion ||
    opts.policyRef ||
    opts.inputHash ||
    opts.policyHash
  ) {
    const missing: string[] = [];
    if (!opts.gateId) missing.push("--gate-id");
    if (!opts.gateDecision) missing.push("--gate-decision");
    if (!opts.inputHash) missing.push("--input-hash");
    if (!opts.policyHash) missing.push("--policy-hash");
    if (!opts.gateName) missing.push("--gate-name");
    if (!opts.gateVersion) missing.push("--gate-version");
    if (!opts.policyRef) missing.push("--policy-ref");
    if (missing.length) {
      throw new Error(`direct mode requires: ${missing.join(", ")}`);
    }

    return buildFromDirectFlags(opts, runner, commitSha);
  }

  // Pipeline mode: read JSON from --input or stdin.
  const raw = await readInputJson(opts.input);
  if (!raw) {
    throw new Error(
      "no input received — pipe a gate-result JSON envelope on stdin OR pass --input <path> OR use direct-mode flags",
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`input is not valid JSON: ${(err as Error).message}`);
  }

  // Pipeline mode validates required keys strictly. The v1→v2 field RENAMES
  // (result→gate_decision, timestamp→evaluated_at) are lossless mappings and
  // are supported for backward compat. The genuinely-NEW v2 fields (gate_name,
  // gate_version, gate_reasons, policy_ref) are REQUIRED — no silent defaults.
  // Synthesizing them would produce fabricated provenance in a signable
  // in-toto statement (P0 fix, consensus option a).
  const required: string[] = ["gate_id", "input_hash", "policy_hash"];
  const missing: string[] = required.filter((k) => !(k in parsed));
  // Require either gate_decision (v2) or result (v1 compat rename)
  if (!("gate_decision" in parsed) && !("result" in parsed)) {
    missing.push("gate_decision");
  }
  // Require the genuinely-new v2 fields — no fallback synthesis (P0 fix).
  if (!("gate_name" in parsed)) missing.push("gate_name");
  if (!("gate_version" in parsed)) missing.push("gate_version");
  if (!("gate_reasons" in parsed)) missing.push("gate_reasons");
  if (!("policy_ref" in parsed)) missing.push("policy_ref");

  if (missing.length) {
    throw new Error(
      `gate-result envelope missing required v2 field(s): ${missing.join(", ")}. ` +
        `A v1-shaped envelope (lacking gate_name/gate_version/gate_reasons/policy_ref) must ` +
        `be re-emitted via the gate that produced it with the --gate-name/--gate-version/` +
        `--gate-reasons/--policy-ref flags set. Pipeline mode will not synthesize these ` +
        `fields because doing so produces fabricated provenance in the signed statement.`,
    );
  }

  // Resolve gate_decision: prefer v2 gate_decision, fall back to v1 result mapping (lossless rename).
  const rawDecision =
    "gate_decision" in parsed
      ? String(parsed.gate_decision)
      : mapV1ResultToV2Decision(String(parsed.result ?? ""));

  // v1 compat: NOT_APPLICABLE routes to coverage.dimensions_skipped
  const { gateDecision, extraSkipped, extraReasons } = resolveDecision(rawDecision);

  // v2 nests coverage at coverage.dimensions_evaluated / coverage.dimensions_skipped
  // (per MIGRATION.md + the kernel gate-result/v1 shape). Read the nested object first,
  // falling back to the flat coverage_evaluated / coverage_skipped keys for v1 back-compat.
  // Prior to this, the flat-key-only read silently emitted [] for every v2 envelope.
  const coverageObj =
    parsed.coverage && typeof parsed.coverage === "object"
      ? (parsed.coverage as Record<string, unknown>)
      : undefined;
  const coverageEvaluated = Array.isArray(coverageObj?.dimensions_evaluated)
    ? (coverageObj!.dimensions_evaluated as string[])
    : Array.isArray(parsed.coverage_evaluated)
      ? (parsed.coverage_evaluated as string[])
      : [];
  const coverageSkipped = [
    ...extraSkipped,
    ...(Array.isArray(coverageObj?.dimensions_skipped)
      ? (coverageObj!.dimensions_skipped as string[])
      : Array.isArray(parsed.coverage_skipped)
        ? (parsed.coverage_skipped as string[])
        : []),
  ];
  const gateReasons = [
    ...(Array.isArray(parsed.gate_reasons) ? (parsed.gate_reasons as string[]) : []),
    ...extraReasons,
  ];

  return {
    gateId: String(parsed.gate_id),
    gateDecision,
    gateName: String(parsed.gate_name),
    gateVersion: String(parsed.gate_version),
    gateReasons,
    coverage: { dimensionsEvaluated: coverageEvaluated, dimensionsSkipped: coverageSkipped },
    policyRef: String(parsed.policy_ref),
    policyHash: String(parsed.policy_hash),
    inputHash: String(parsed.input_hash),
    runner,
    commitSha,
    metadata: parsed.metadata as Record<string, unknown> | undefined,
    failureMode: parsed.failure_mode as string | undefined,
    advisorySeverity:
      typeof parsed.advisory_severity === "string"
        ? parseSeverity(parsed.advisory_severity)
        : undefined,
  };
}

function buildFromDirectFlags(
  opts: EmitEvidenceOptions,
  runner: string,
  commitSha: string,
): ComposeStatementInput {
  // NOT_APPLICABLE routing: if --gate-decision NOT_APPLICABLE, emit a pass with
  // the reserved token added to dimensionsSkipped (DR-018 §279).
  const rawDecision = opts.gateDecision!;
  const { gateDecision, extraSkipped, extraReasons } = resolveDecision(rawDecision);

  const coverageSkipped = [...extraSkipped, ...(opts.coverageSkipped ?? [])];
  const gateReasons = [...(opts.gateReason ?? []), ...extraReasons];

  return {
    gateId: opts.gateId!,
    gateDecision,
    gateName: opts.gateName!,
    gateVersion: opts.gateVersion!,
    gateReasons,
    coverage: {
      dimensionsEvaluated: opts.coverageEvaluated ?? [],
      dimensionsSkipped: coverageSkipped,
    },
    policyRef: opts.policyRef!,
    policyHash: opts.policyHash!,
    inputHash: opts.inputHash!,
    runner,
    commitSha,
    metadata: opts.metadata ? parseMetadata(opts.metadata) : undefined,
    failureMode: opts.failureMode,
    advisorySeverity: opts.advisorySeverity ? parseSeverity(opts.advisorySeverity) : undefined,
  };
}

/**
 * Reserved token for NOT_APPLICABLE routing. Uses a non-colliding name so it
 * can never shadow a real dimension name passed via --coverage-skipped (P1 fix).
 * Verifiers reading `pass + empty dimensions_evaluated + this token` MUST treat
 * the row as a non-verdict, NOT a green light — document this in MIGRATION.md.
 */
const NOT_APPLICABLE_SKIPPED_TOKEN = "__not_applicable__" as const;

/**
 * Resolve a raw decision string into a valid GateResult plus any extra
 * dimensions to add to coverage.dimensionsSkipped and any extra reasons to
 * append to gate_reasons.
 *
 * NOT_APPLICABLE → {
 *   gateDecision: "pass",
 *   extraSkipped: ["__not_applicable__"],
 *   extraReasons: ["routed from NOT_APPLICABLE per DR-018 §279 — non-verdict, not a pass"]
 * }
 * All other values → validated as GateResult, no extras.
 */
export function resolveDecision(raw: string): {
  gateDecision: GateResult;
  extraSkipped: string[];
  extraReasons: string[];
} {
  if (raw === NOT_APPLICABLE_SENTINEL || raw.toUpperCase() === NOT_APPLICABLE_SENTINEL) {
    return {
      gateDecision: "pass",
      extraSkipped: [NOT_APPLICABLE_SKIPPED_TOKEN],
      extraReasons: ["routed from NOT_APPLICABLE per DR-018 §279 — non-verdict, not a pass"],
    };
  }
  return { gateDecision: parseDecision(raw), extraSkipped: [], extraReasons: [] };
}

/**
 * Map v1 result values (uppercase PASS/FAIL/ADVISORY/NOT_APPLICABLE) to
 * v2 gate_decision values (lowercase pass/fail/advisory/error).
 * Exported for unit testing (P2 fix).
 */
export function mapV1ResultToV2Decision(v1: string): string {
  switch (v1.toUpperCase()) {
    case "PASS":
      return "pass";
    case "FAIL":
      return "fail";
    case "ADVISORY":
      return "advisory";
    case "NOT_APPLICABLE":
      return NOT_APPLICABLE_SENTINEL;
    default:
      return v1.toLowerCase();
  }
}

function parseDecision(s: string): GateResult {
  const check = GateResultEnum.safeParse(s);
  if (!check.success) {
    throw new Error(
      `invalid gate_decision '${s}' (expected one of: ${GateResultEnum.options.join(", ")})`,
    );
  }
  return check.data;
}

function parseSeverity(s: string): AdvisorySeverity {
  const check = AdvisorySeverityEnum.safeParse(s);
  if (!check.success) {
    throw new Error(
      `invalid advisory_severity '${s}' (expected one of: ${AdvisorySeverityEnum.options.join(", ")})`,
    );
  }
  return check.data;
}

function parseMetadata(s: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(s);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new Error("metadata must be a JSON object");
    }
    return obj as Record<string, unknown>;
  } catch (err) {
    throw new Error(`--metadata is not a valid JSON object: ${(err as Error).message}`);
  }
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

function safeGitHead(): string {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    // The sentinel satisfies COMMIT_SHA_REGEX but is semantically NOT a real
    // commit — never embed it silently. Warn so CI logs surface the gap and
    // operators pass --commit-sha explicitly.
    process.stderr.write(
      "j-rig emit-evidence: warning: could not resolve git HEAD (not a git repository?); " +
        "embedding sentinel commit_sha '0000000' — pass --commit-sha to record the real commit\n",
    );
    return "0000000";
  }
}
