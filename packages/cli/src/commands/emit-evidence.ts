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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  composeStatement,
  serializeStatement,
  GateResultEnum,
  AdvisorySeverityEnum,
  type GateResult,
  type AdvisorySeverity,
  type ComposeStatementInput,
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
            timestamp: composed.timestamp,
          };
          process.stderr.write(`[OTEL] ${JSON.stringify(evt)}\n`);
        }

        const serialized = serializeStatement(statement);
        if (opts.output) {
          const outAbs = resolve(opts.output);
          if (!existsSync(dirname(outAbs))) mkdirSync(dirname(outAbs), { recursive: true });
          writeFileSync(outAbs, serialized + "\n");
          process.stderr.write(`emit-evidence: wrote ${outAbs}\n`);
        } else {
          process.stdout.write(serialized + "\n");
        }
        process.exit(0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`j-rig emit-evidence: ${msg}\n`);
        process.exit(opts.output ? 2 : 1);
      }
    });
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
