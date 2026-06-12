import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { registerEmitEvidenceCommand, resolveDecision, mapV1ResultToV2Decision } from "./emit-evidence.js";

/**
 * These tests exercise the commander-registered handler by spawning the built
 * CLI as a subprocess. This is the only way to assert over stdout/stderr
 * separation and exit codes. The cosign-dependent --sign path is covered by
 * the smoke-tested integration in dev; here we test only the no-cosign paths.
 *
 * v2 changes tested:
 *   - --gate-decision (was --result; lowercase values)
 *   - --gate-name, --gate-version, --policy-ref (NEW required in direct mode)
 *   - --gate-reason (repeatable; replaces inline reasons)
 *   - --coverage-evaluated, --coverage-skipped (repeatable)
 *   - NOT_APPLICABLE routing to coverage.dimensions_skipped
 *   - predicate body uses gate_decision/evaluated_at (not result/timestamp)
 */

const SHA = "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("node", [CLI_PATH, ...args], { encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

/** v2 base args for direct mode — all required flags. */
const baseDirectArgs = [
  "emit-evidence",
  "--gate-id", "j-rig:server:MM-1",
  "--gate-decision", "pass",
  "--gate-name", "mm-1-async-race",
  "--gate-version", "2.0.0",
  "--gate-reason", "all criteria met",
  "--coverage-evaluated", "async-race",
  "--policy-ref", `sha256:${SHA}:vitest.config.ts`,
  "--input-hash", `sha256:${SHA}`,
  "--policy-hash", `sha256:${SHA}`,
  "--runner-version", "j-rig@2.0.0",
  "--commit-sha", "abc1234",
];

describe("registerEmitEvidenceCommand — registration", () => {
  it("registers the emit-evidence subcommand on a Commander program", () => {
    const program = new Command();
    registerEmitEvidenceCommand(program);
    const cmd = program.commands.find((c) => c.name() === "emit-evidence");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/in-toto Statement v1/);
  });
});

describe("emit-evidence CLI integration (no cosign) — v2 body shape", () => {
  it("emits a full Statement to stdout in plain mode (direct args)", () => {
    const r = runCli(baseDirectArgs);
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    expect(stmt._type).toBe("https://in-toto.io/Statement/v1");
    expect(stmt.predicateType).toBe("https://evals.intentsolutions.io/gate-result/v1");
    expect(stmt.predicate.gate_id).toBe("j-rig:server:MM-1");
    // v2 fields
    expect(stmt.predicate.gate_decision).toBe("pass");
    expect(stmt.predicate.gate_name).toBe("mm-1-async-race");
    expect(stmt.predicate.gate_version).toBe("2.0.0");
    expect(stmt.predicate.gate_reasons).toEqual(["all criteria met"]);
    expect(stmt.predicate.coverage.dimensions_evaluated).toContain("async-race");
    expect(stmt.predicate.evaluated_at).toBeDefined();
    // v1 fields MUST NOT be present
    expect(stmt.predicate.result).toBeUndefined();
    expect(stmt.predicate.timestamp).toBeUndefined();
  });

  it("emits ONLY the predicate body when --predicate-body-only is set", () => {
    const r = runCli([...baseDirectArgs, "--predicate-body-only"]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body._type).toBeUndefined(); // not a full Statement
    expect(body.predicateType).toBeUndefined();
    expect(body.gate_id).toBe("j-rig:server:MM-1");
    expect(body.gate_decision).toBe("pass"); // v2 field
  });

  it("routes NOT_APPLICABLE to coverage.dimensions_skipped (not a gate_decision)", () => {
    const r = runCli([
      "emit-evidence",
      "--gate-id", "j-rig:server:MM-3",
      "--gate-decision", "NOT_APPLICABLE",
      "--gate-name", "mm-3-cooldown",
      "--gate-version", "2.0.0",
      "--policy-ref", `sha256:${SHA}:vitest.config.ts`,
      "--input-hash", `sha256:${SHA}`,
      "--policy-hash", `sha256:${SHA}`,
      "--runner-version", "j-rig@2.0.0",
      "--commit-sha", "abc1234",
    ]);
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    // NOT_APPLICABLE → gate_decision=pass, reserved token added to skipped (P1 fix)
    expect(stmt.predicate.gate_decision).toBe("pass");
    expect(stmt.predicate.coverage.dimensions_skipped).toContain("__not_applicable__");
  });

  it("--coverage-skipped adds to dimensions_skipped", () => {
    const r = runCli([
      ...baseDirectArgs,
      "--coverage-skipped", "functions",
      "--coverage-skipped", "branches",
    ]);
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    expect(stmt.predicate.coverage.dimensions_skipped).toContain("functions");
    expect(stmt.predicate.coverage.dimensions_skipped).toContain("branches");
  });

  it("--sign without --key OR --keyless exits 1 with a clear error", () => {
    const r = runCli([...baseDirectArgs, "--sign"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--sign requires --key.*OR --keyless/);
  });

  it("--key implies --sign and attempts cosign (exits 2 if cosign not found)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const artifactPath = join(tmpDir, "artifact.bin");
      const content = "hello world\n";
      writeFileSync(artifactPath, content);
      const realHash = createHash("sha256").update(content).digest("hex");

      const r = runCli([
        "emit-evidence",
        "--gate-id", "j-rig:server:MM-1",
        "--gate-decision", "pass",
        "--gate-name", "mm-1-async-race",
        "--gate-version", "2.0.0",
        "--policy-ref", `sha256:${SHA}:vitest.config.ts`,
        "--input-hash", `sha256:${realHash}`,
        "--policy-hash", `sha256:${SHA}`,
        "--runner-version", "j-rig@2.0.0",
        "--commit-sha", "abc1234",
        "--key", "/nonexistent.key",
        "--cosign-bin", "/nonexistent/cosign-binary",
        "--artifact", artifactPath,
      ]);
      // Exit 2 when cosign binary cannot be spawned.
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/failed to spawn cosign/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--sign without --artifact refuses with a clear error", () => {
    const r = runCli([...baseDirectArgs, "--keyless"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--sign requires --artifact/);
  });

  it("--sign with --artifact whose hash mismatches predicate.input_hash refuses", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const artifactPath = join(tmpDir, "artifact.bin");
      writeFileSync(artifactPath, "wrong content\n");
      const r = runCli([
        ...baseDirectArgs,
        "--keyless",
        "--artifact", artifactPath,
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--artifact sha256 mismatch/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON on stdin in pipeline mode", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const inputFile = join(tmpDir, "bad.json");
      writeFileSync(inputFile, "{not valid json");
      const r = runCli(["emit-evidence", "--input", inputFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/not valid JSON/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects pipeline input missing required keys", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const inputFile = join(tmpDir, "incomplete.json");
      writeFileSync(inputFile, '{"gate_id": "j-rig:server:MM-1"}');
      const r = runCli(["emit-evidence", "--input", inputFile]);
      expect(r.code).toBe(1);
      // Updated message per P0 fix: now "missing required v2 field(s)"
      expect(r.stderr).toMatch(/missing required v2 field/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--output writes to file and emits an info line on stderr", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const outFile = join(tmpDir, "stmt.json");
      const r = runCli([...baseDirectArgs, "--output", outFile]);
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/wrote .*stmt.json/);
      const written = JSON.parse(readFileSync(outFile, "utf-8"));
      expect(written.predicate.gate_id).toBe("j-rig:server:MM-1");
      expect(written.predicate.gate_decision).toBe("pass");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("direct mode requires --gate-name (v2 required field)", () => {
    const argsWithoutGateName = baseDirectArgs.filter(
      (a, i) => a !== "--gate-name" && baseDirectArgs[i - 1] !== "--gate-name",
    );
    const r = runCli(argsWithoutGateName);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--gate-name/);
  });

  it("direct mode requires --gate-version (v2 required field)", () => {
    const argsWithoutGateVersion = baseDirectArgs.filter(
      (a, i) => a !== "--gate-version" && baseDirectArgs[i - 1] !== "--gate-version",
    );
    const r = runCli(argsWithoutGateVersion);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--gate-version/);
  });

  it("direct mode requires --policy-ref (v2 required field)", () => {
    const argsWithoutPolicyRef = baseDirectArgs.filter(
      (a, i) => a !== "--policy-ref" && baseDirectArgs[i - 1] !== "--policy-ref",
    );
    const r = runCli(argsWithoutPolicyRef);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--policy-ref/);
  });

  // ── P0 — pipeline mode rejects v1-shaped envelopes (fabricated-provenance fix) ──

  it("pipeline mode rejects a v1-shaped envelope missing all new v2 fields (P0 fix)", () => {
    // A genuine v1 envelope has only: gate_id, result, policy_hash, input_hash, timestamp.
    // Pipeline mode MUST reject it with a clear error listing the missing fields.
    // It must NOT silently synthesize gate_name/gate_version/gate_reasons/policy_ref.
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const v1Envelope = {
        gate_id: "j-rig:server:MM-1",
        result: "PASS",
        policy_hash: `sha256:${SHA}`,
        input_hash: `sha256:${SHA}`,
        timestamp: "2026-01-01T00:00:00Z",
      };
      const inputFile = join(tmpDir, "v1-envelope.json");
      writeFileSync(inputFile, JSON.stringify(v1Envelope));
      const r = runCli(["emit-evidence", "--input", inputFile]);
      // Must reject — non-zero exit, never a silent emit
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/missing required v2 field/);
      // Must name the missing fields
      expect(r.stderr).toMatch(/gate_name/);
      expect(r.stderr).toMatch(/gate_version/);
      expect(r.stderr).toMatch(/gate_reasons/);
      expect(r.stderr).toMatch(/policy_ref/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("pipeline mode accepts a fully v2-shaped envelope", () => {
    // A v2 envelope with all required fields must succeed.
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const v2Envelope = {
        gate_id: "j-rig:server:MM-1",
        gate_decision: "pass",
        gate_name: "mm-1-async-race",
        gate_version: "2.0.0",
        gate_reasons: ["all criteria met"],
        coverage: { dimensions_evaluated: ["async-race"], dimensions_skipped: [] },
        policy_ref: `sha256:${SHA}:vitest.config.ts`,
        policy_hash: `sha256:${SHA}`,
        input_hash: `sha256:${SHA}`,
      };
      const inputFile = join(tmpDir, "v2-envelope.json");
      writeFileSync(inputFile, JSON.stringify(v2Envelope));
      const r = runCli([
        "emit-evidence",
        "--input", inputFile,
        "--runner-version", "j-rig@2.0.0",
        "--commit-sha", "abc1234",
      ]);
      expect(r.code).toBe(0);
      const stmt = JSON.parse(r.stdout);
      expect(stmt.predicate.gate_decision).toBe("pass");
      expect(stmt.predicate.gate_name).toBe("mm-1-async-race");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── P1 exit-code — validation failure WITH --output must still exit 1 ──

  it("invalid input WITH --output exits 1, not 2 (P1 exit-code fix)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const inputFile = join(tmpDir, "bad.json");
      const outFile = join(tmpDir, "output.json");
      // Missing gate_decision and all new v2 fields
      writeFileSync(inputFile, JSON.stringify({ gate_id: "j-rig:server:MM-1" }));
      const r = runCli([
        "emit-evidence",
        "--input", inputFile,
        "--output", outFile,
      ]);
      // Pre-write validation errors always exit 1, never 2 (2 is for write failures)
      expect(r.code).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── P1 NOT_APPLICABLE — reserved token and self-description ──

  it("NOT_APPLICABLE uses __not_applicable__ reserved token (not a real dimension name)", () => {
    const r = runCli([
      "emit-evidence",
      "--gate-id", "j-rig:server:MM-3",
      "--gate-decision", "NOT_APPLICABLE",
      "--gate-name", "mm-3-cooldown",
      "--gate-version", "2.0.0",
      "--policy-ref", `sha256:${SHA}:vitest.config.ts`,
      "--input-hash", `sha256:${SHA}`,
      "--policy-hash", `sha256:${SHA}`,
      "--runner-version", "j-rig@2.0.0",
      "--commit-sha", "abc1234",
    ]);
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    // Sentinel is the reserved non-colliding token
    expect(stmt.predicate.coverage.dimensions_skipped).toContain("__not_applicable__");
    // Must NOT contain the bare literal "not-applicable" (old colliding value)
    expect(stmt.predicate.coverage.dimensions_skipped).not.toContain("not-applicable");
    // Self-describing reason added to gate_reasons
    expect(stmt.predicate.gate_reasons.join(" ")).toMatch(/non-verdict/);
    expect(stmt.predicate.gate_reasons.join(" ")).toMatch(/DR-018/);
  });

  it("real dimension name via --coverage-skipped flows through unchanged (sentinel cannot shadow it)", () => {
    const r = runCli([
      ...baseDirectArgs,
      "--coverage-skipped", "real-dimension-name",
      "--coverage-skipped", "__not_applicable__",  // reserved token itself
    ]);
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    // Both values present and unmodified
    expect(stmt.predicate.coverage.dimensions_skipped).toContain("real-dimension-name");
    expect(stmt.predicate.coverage.dimensions_skipped).toContain("__not_applicable__");
  });
});

// ── P2 — helper unit tests: resolveDecision and v1→v2 mapping ──

describe("resolveDecision helper (direct unit tests)", () => {
  it("pass → gateDecision=pass, no extras", () => {
    const r = resolveDecision("pass");
    expect(r.gateDecision).toBe("pass");
    expect(r.extraSkipped).toHaveLength(0);
    expect(r.extraReasons).toHaveLength(0);
  });

  it("fail → gateDecision=fail, no extras", () => {
    const r = resolveDecision("fail");
    expect(r.gateDecision).toBe("fail");
    expect(r.extraSkipped).toHaveLength(0);
    expect(r.extraReasons).toHaveLength(0);
  });

  it("advisory → gateDecision=advisory, no extras", () => {
    const r = resolveDecision("advisory");
    expect(r.gateDecision).toBe("advisory");
    expect(r.extraSkipped).toHaveLength(0);
    expect(r.extraReasons).toHaveLength(0);
  });

  it("error → gateDecision=error, no extras", () => {
    const r = resolveDecision("error");
    expect(r.gateDecision).toBe("error");
    expect(r.extraSkipped).toHaveLength(0);
    expect(r.extraReasons).toHaveLength(0);
  });

  it("NOT_APPLICABLE → pass + __not_applicable__ sentinel + self-describing reason", () => {
    const r = resolveDecision("NOT_APPLICABLE");
    expect(r.gateDecision).toBe("pass");
    expect(r.extraSkipped).toContain("__not_applicable__");
    expect(r.extraSkipped).not.toContain("not-applicable"); // old colliding value must be gone
    expect(r.extraReasons.length).toBeGreaterThan(0);
    expect(r.extraReasons[0]).toMatch(/non-verdict/);
    expect(r.extraReasons[0]).toMatch(/DR-018/);
  });

  it("not_applicable (lowercase) → same routing as NOT_APPLICABLE", () => {
    const r = resolveDecision("not_applicable");
    expect(r.gateDecision).toBe("pass");
    expect(r.extraSkipped).toContain("__not_applicable__");
  });

  it("invalid value throws with a clear error", () => {
    expect(() => resolveDecision("BOGUS")).toThrow(/invalid gate_decision/);
  });
});

// ── P2 — v1→v2 result mapping unit tests ──

describe("mapV1ResultToV2Decision helper (direct unit tests)", () => {
  it("maps PASS → pass", () => {
    expect(mapV1ResultToV2Decision("PASS")).toBe("pass");
  });

  it("maps FAIL → fail", () => {
    expect(mapV1ResultToV2Decision("FAIL")).toBe("fail");
  });

  it("maps ADVISORY → advisory", () => {
    expect(mapV1ResultToV2Decision("ADVISORY")).toBe("advisory");
  });

  it("maps NOT_APPLICABLE → NOT_APPLICABLE sentinel (caller routes to coverage.dimensions_skipped)", () => {
    // NOT_APPLICABLE maps to the sentinel string — resolveDecision then routes it.
    expect(mapV1ResultToV2Decision("NOT_APPLICABLE")).toBe("NOT_APPLICABLE");
  });

  it("maps unknown/null-like values to lowercase (passthrough)", () => {
    // Unknown values are lowercased so parseDecision can produce a clean error.
    expect(mapV1ResultToV2Decision("UNKNOWN")).toBe("unknown");
    expect(mapV1ResultToV2Decision("")).toBe("");
  });

  it("maps lowercase pass → pass (idempotent for already-v2 values)", () => {
    expect(mapV1ResultToV2Decision("pass")).toBe("pass");
    expect(mapV1ResultToV2Decision("fail")).toBe("fail");
  });
});
