/**
 * `j-rig emit-evidence` — wrap a gate-result envelope (or build one from
 * j-rig's own verdict output) into an in-toto Statement v1 carrying the
 * Evidence Bundle predicate URI.
 *
 * Two input modes:
 *
 *   1. Pipeline mode (stdin / --input):
 *        echo '{"gate_id":"...","result":"PASS",...}' | j-rig emit-evidence
 *      Reads a partial gate-result envelope (the same shape audit-harness
 *      gates emit via --json) and augments it with timestamp/runner/commit_sha.
 *
 *   2. Direct mode (--gate-id, --result, ...):
 *        j-rig emit-evidence --gate-id 'j-rig:server:MM-1' --result PASS \
 *          --input-hash sha256:... --policy-hash sha256:...
 *      Builds a row from explicit flags. Useful for shell-driving from the
 *      eval CLI when refactoring is in flight.
 *
 * Output:
 *   stdout = the in-toto Statement JSON (single line, ready for piping to
 *            cosign attest-blob or to a Bundle accumulator)
 *   stderr = log lines (best-effort OTel agent.rollout.gate.evaluated event
 *            when AUDIT_HARNESS_OTEL=1 or OTEL_EXPORTER_OTLP_ENDPOINT set)
 *
 * Exit codes:
 *   0  Statement emitted
 *   1  input malformed or missing required fields
 *   2  --output write failed
 */
import type { Command } from "commander";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
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
  // Direct-mode flags
  gateId?: string;
  result?: string;
  inputHash?: string;
  policyHash?: string;
  failureMode?: string;
  advisorySeverity?: string;
  metadata?: string;
  // Signing flags (cosign integration; see SPEC.md § 7)
  sign?: boolean;
  key?: string;
  keyless?: boolean;
  rekorUrl?: string;
  predicateBodyOnly?: boolean;
  cosignBin?: string;
  artifact?: string;
}

const DEFAULT_RUNNER_VERSION = "j-rig@0.0.0-dev"; // overridden when packaged

export function registerEmitEvidenceCommand(program: Command): void {
  program
    .command("emit-evidence")
    .description(
      "Wrap a gate-result envelope into a signed in-toto Statement v1 (https://evals.intentsolutions.io/gate-result/v1)",
    )
    .option(
      "--input <path>",
      "Read gate-result JSON from <path> instead of stdin",
    )
    .option("--output <path>", "Write Statement to <path> instead of stdout")
    .option(
      "--runner-version <ver>",
      'Override runner identifier (default: "j-rig@<package version>")',
    )
    .option(
      "--commit-sha <sha>",
      "Override commit SHA (default: git rev-parse HEAD)",
    )
    // Direct-mode flags
    .option("--gate-id <id>", "Direct mode: gate id (e.g. 'j-rig:server:MM-1')")
    .option("--result <r>", "Direct mode: PASS|FAIL|ADVISORY|NOT_APPLICABLE")
    .option("--input-hash <h>", "Direct mode: sha256:<64-hex>")
    .option("--policy-hash <h>", "Direct mode: sha256:<64-hex>")
    .option("--failure-mode <m>", "Direct mode: failure_mode (when result=FAIL)")
    .option(
      "--advisory-severity <s>",
      "Direct mode: info|warn|error (when result=ADVISORY)",
    )
    .option(
      "--metadata <json>",
      "Direct mode: free-form metadata as a JSON object string",
    )
    // --- Signing (cosign integration; SPEC.md § 7) ---
    .option(
      "--sign",
      "Sign the Statement via cosign (requires --key OR --keyless). Without this flag, emits unsigned Statement.",
    )
    .option(
      "--key <ref>",
      "cosign key reference (file path, KMS URI, etc). Implies --sign.",
    )
    .option(
      "--keyless",
      "cosign keyless signing via Fulcio OIDC (requires terminal). Implies --sign.",
    )
    .option(
      "--rekor-url <url>",
      "Push the signed attestation to Rekor at <url> (default: https://rekor.sigstore.dev when used without value). Implies --sign.",
    )
    .option(
      "--predicate-body-only",
      "Emit ONLY the predicate body (cosign-friendly). Cosign attest-blob then wraps it in its own Statement envelope. Without this, emits the full v1 Statement.",
    )
    .option(
      "--cosign-bin <path>",
      "Path to cosign binary (default: cosign on PATH).",
      "cosign",
    )
    .option(
      "--artifact <path>",
      "Path to the artifact whose sha256 must equal predicate.input_hash. Required when --sign is requested so the DSSE envelope's subject digest is cryptographically bound to the gate's input. Without this, the link between attestation and artifact cannot be verified by standard tooling.",
    )
    .action(async (opts: EmitEvidenceOptions) => {
      try {
        const composed = await buildComposeInput(opts);
        const statement = composeStatement(composed);

        // OTel best-effort emission (mirrors audit-harness emit-evidence.sh)
        if (
          process.env.AUDIT_HARNESS_OTEL === "1" ||
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ) {
          const evt = {
            name: "agent.rollout.gate.evaluated",
            attributes: {
              "gate.id": composed.gateId,
              "gate.result": composed.result,
              "gate.runner": composed.runner,
              "gate.commit_sha": composed.commitSha,
            },
            timestamp: statement.predicate.timestamp,
          };
          process.stderr.write(`[OTEL] ${JSON.stringify(evt)}\n`);
        }

        const wantsSigning =
          opts.sign === true ||
          opts.key !== undefined ||
          opts.keyless === true ||
          opts.rekorUrl !== undefined;

        if (!wantsSigning) {
          // Plain mode (Phase 1 behavior preserved): emit the chosen shape.
          const out = opts.predicateBodyOnly
            ? JSON.stringify(statement.predicate)
            : serializeStatement(statement);
          writeOut(out, opts);
          process.exit(0);
        }

        // Signing mode: invoke cosign attest-blob over a synthetic blob whose
        // sha256 matches the predicate's input_hash. Per SPEC § R10 the
        // resulting DSSE envelope wraps the predicate body in a Statement;
        // cosign's outer wrap uses Statement v0.1 (cosign default).
        const exitCode = signAndEmit(statement, composed, opts);
        process.exit(exitCode);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`j-rig emit-evidence: ${msg}\n`);
        process.exit(opts.output ? 2 : 1);
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
    process.stderr.write(
      "j-rig emit-evidence: --sign requires --key <ref> OR --keyless\n",
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
    process.stderr.write(
      `j-rig emit-evidence: --artifact path does not exist: ${artifactAbs}\n`,
    );
    return 1;
  }
  // Verify the artifact's sha256 matches predicate.input_hash BEFORE signing.
  // If they diverge, the resulting attestation would be cryptographically
  // unverifiable; failing now is better than emitting a broken envelope.
  const artifactBytes = readFileSync(artifactAbs);
  const actualHash = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
  if (actualHash !== composed.inputHash) {
    process.stderr.write(
      `j-rig emit-evidence: --artifact sha256 mismatch:\n  computed: ${actualHash}\n  predicate.input_hash: ${composed.inputHash}\nThe artifact passed to --sign must be the exact file whose hash the gate recorded.\n`,
    );
    return 1;
  }

  const tmp = mkdtempSync(join(tmpdir(), "j-rig-emit-evidence-"));
  try {
    // Predicate file: by default we send just the predicate body (cosign
    // wraps it in its own Statement v0.1 envelope with our predicateType).
    // Users can opt out via --predicate-body-only=false to preserve a
    // pre-formed Statement (which cosign will then nest).
    const predicatePath = join(tmp, "predicate.json");
    const predicateContent = opts.predicateBodyOnly
      ? JSON.stringify(statement.predicate, null, 2)
      : JSON.stringify(statement, null, 2);
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
      `--tlog-upload=${opts.rekorUrl || opts.keyless ? "true" : "false"}`,
    ];
    if (opts.key) args.push("--key", opts.key);
    else if (opts.keyless) args.push("--yes"); // cosign keyless OIDC accept
    if (opts.rekorUrl) args.push("--rekor-url", opts.rekorUrl);
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
      `emit-evidence: signed envelope emitted${opts.rekorUrl ? ` (Rekor: ${opts.rekorUrl})` : ""}\n`,
    );
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function buildComposeInput(
  opts: EmitEvidenceOptions,
): Promise<ComposeStatementInput> {
  const runner = opts.runnerVersion ?? DEFAULT_RUNNER_VERSION;
  const commitSha = opts.commitSha ?? safeGitHead();

  // Direct mode: explicit flags trump stdin.
  if (opts.gateId || opts.result || opts.inputHash || opts.policyHash) {
    const missing: string[] = [];
    if (!opts.gateId) missing.push("--gate-id");
    if (!opts.result) missing.push("--result");
    if (!opts.inputHash) missing.push("--input-hash");
    if (!opts.policyHash) missing.push("--policy-hash");
    if (missing.length) {
      throw new Error(`direct mode requires: ${missing.join(", ")}`);
    }
    return {
      gateId: opts.gateId!,
      result: parseResult(opts.result!),
      policyHash: opts.policyHash!,
      inputHash: opts.inputHash!,
      runner,
      commitSha,
      metadata: opts.metadata ? parseMetadata(opts.metadata) : undefined,
      failureMode: opts.failureMode,
      advisorySeverity: opts.advisorySeverity
        ? parseSeverity(opts.advisorySeverity)
        : undefined,
    };
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

  const required = ["gate_id", "result", "input_hash", "policy_hash"] as const;
  const missing = required.filter((k) => !(k in parsed));
  if (missing.length) {
    throw new Error(
      `gate-result envelope missing required keys: ${missing.join(", ")}`,
    );
  }

  return {
    gateId: String(parsed.gate_id),
    result: parseResult(String(parsed.result)),
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

function parseResult(s: string): GateResult {
  const check = GateResultEnum.safeParse(s);
  if (!check.success) {
    throw new Error(
      `invalid result '${s}' (expected one of: ${GateResultEnum.options.join(", ")})`,
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
    return "0000000";
  }
}
