import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { registerEmitEvidenceCommand } from "./emit-evidence.js";

/**
 * These tests exercise the commander-registered handler indirectly by
 * spawning the built CLI as a subprocess. This is the only way to assert
 * over stdout/stderr separation and exit codes that the handler uses
 * process.stdout / process.exit() for. The cosign-dependent --sign path is
 * covered by the smoke-tested integration in dev (cosign at ~/bin/cosign);
 * here we test only the no-cosign code paths.
 */

const SHA = "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("node", [CLI_PATH, ...args], { encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

/**
 * Build an artifact whose sha256 the predicate can carry, plus a FAKE cosign
 * binary that echoes the --predicate file's content into --output-signature.
 * Lets the tests observe exactly what the signing path feeds cosign without
 * needing a real cosign install.
 */
function makeSigningFixture(tmpDir: string): {
  artifactPath: string;
  realHash: string;
  fakeCosign: string;
} {
  const artifactPath = join(tmpDir, "artifact.bin");
  const content = "hello world\n";
  writeFileSync(artifactPath, content);
  const realHash = createHash("sha256").update(content).digest("hex");

  const fakeCosign = join(tmpDir, "fake-cosign.cjs");
  writeFileSync(
    fakeCosign,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const predicate = args[args.indexOf("--predicate") + 1];',
      'const out = args[args.indexOf("--output-signature") + 1];',
      "fs.writeFileSync(out, fs.readFileSync(predicate));",
      "",
    ].join("\n"),
  );
  chmodSync(fakeCosign, 0o755);
  return { artifactPath, realHash, fakeCosign };
}

describe("registerEmitEvidenceCommand — registration", () => {
  it("registers the emit-evidence subcommand on a Commander program", () => {
    const program = new Command();
    registerEmitEvidenceCommand(program);
    const cmd = program.commands.find((c) => c.name() === "emit-evidence");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/in-toto Statement v1/);
  });
});

describe("emit-evidence CLI integration (no cosign)", () => {
  it("emits a full Statement to stdout in plain mode (direct args)", () => {
    const r = runCli([
      "emit-evidence",
      "--gate-id",
      "j-rig:server:MM-1",
      "--result",
      "PASS",
      "--input-hash",
      `sha256:${SHA}`,
      "--policy-hash",
      `sha256:${SHA}`,
      "--runner-version",
      "j-rig@0.15.0",
      "--commit-sha",
      "abc1234",
    ]);
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    expect(stmt._type).toBe("https://in-toto.io/Statement/v1");
    expect(stmt.predicateType).toBe("https://evals.intentsolutions.io/gate-result/v1");
    expect(stmt.predicate.gate_id).toBe("j-rig:server:MM-1");
  });

  it("emits ONLY the predicate body when --predicate-body-only is set", () => {
    const r = runCli([
      "emit-evidence",
      "--gate-id",
      "j-rig:server:MM-1",
      "--result",
      "PASS",
      "--input-hash",
      `sha256:${SHA}`,
      "--policy-hash",
      `sha256:${SHA}`,
      "--runner-version",
      "j-rig@0.15.0",
      "--commit-sha",
      "abc1234",
      "--predicate-body-only",
    ]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body._type).toBeUndefined(); // not a full Statement
    expect(body.predicateType).toBeUndefined();
    expect(body.gate_id).toBe("j-rig:server:MM-1");
    expect(body.result).toBe("PASS");
  });

  it("--sign without --key OR --keyless exits 1 with a clear error", () => {
    const r = runCli([
      "emit-evidence",
      "--gate-id",
      "j-rig:server:MM-1",
      "--result",
      "PASS",
      "--input-hash",
      `sha256:${SHA}`,
      "--policy-hash",
      `sha256:${SHA}`,
      "--runner-version",
      "j-rig@0.15.0",
      "--commit-sha",
      "abc1234",
      "--sign",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--sign requires --key.*OR --keyless/);
  });

  it("--key implies --sign and attempts cosign (exits 2 if cosign not found)", () => {
    // Need a real artifact whose sha256 matches the predicate input_hash so
    // the new --artifact pre-check passes (and we actually reach cosign spawn).
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const artifactPath = join(tmpDir, "artifact.bin");
      const content = "hello world\n";
      writeFileSync(artifactPath, content);
      const realHash = createHash("sha256").update(content).digest("hex");

      const r = runCli([
        "emit-evidence",
        "--gate-id",
        "j-rig:server:MM-1",
        "--result",
        "PASS",
        "--input-hash",
        `sha256:${realHash}`,
        "--policy-hash",
        `sha256:${SHA}`,
        "--runner-version",
        "j-rig@0.15.0",
        "--commit-sha",
        "abc1234",
        "--key",
        "/nonexistent.key",
        "--cosign-bin",
        "/nonexistent/cosign-binary",
        "--artifact",
        artifactPath,
      ]);
      // Exit 2 when cosign binary cannot be spawned.
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/failed to spawn cosign/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--sign without --artifact refuses with a clear error", () => {
    const r = runCli([
      "emit-evidence",
      "--gate-id",
      "j-rig:server:MM-1",
      "--result",
      "PASS",
      "--input-hash",
      `sha256:${SHA}`,
      "--policy-hash",
      `sha256:${SHA}`,
      "--runner-version",
      "j-rig@0.15.0",
      "--commit-sha",
      "abc1234",
      "--keyless",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--sign requires --artifact/);
  });

  it("--sign with --artifact whose hash mismatches predicate.input_hash refuses", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const artifactPath = join(tmpDir, "artifact.bin");
      writeFileSync(artifactPath, "wrong content\n");
      const r = runCli([
        "emit-evidence",
        "--gate-id",
        "j-rig:server:MM-1",
        "--result",
        "PASS",
        "--input-hash",
        `sha256:${SHA}`,
        "--policy-hash",
        `sha256:${SHA}`,
        "--runner-version",
        "j-rig@0.15.0",
        "--commit-sha",
        "abc1234",
        "--keyless",
        "--artifact",
        artifactPath,
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
      expect(r.stderr).toMatch(/missing required keys/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("signing path feeds cosign the PREDICATE BODY by default, not the full Statement [f-jrig-security-1]", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const { artifactPath, realHash, fakeCosign } = makeSigningFixture(tmpDir);
      const r = runCli([
        "emit-evidence",
        "--gate-id",
        "j-rig:server:MM-1",
        "--result",
        "PASS",
        "--input-hash",
        `sha256:${realHash}`,
        "--policy-hash",
        `sha256:${SHA}`,
        "--runner-version",
        "j-rig@0.15.0",
        "--commit-sha",
        "abc1234",
        "--key",
        "/fake.key",
        "--cosign-bin",
        fakeCosign,
        "--artifact",
        artifactPath,
      ]);
      expect(r.code).toBe(0);
      // The fake cosign echoes the --predicate file content back as the
      // "signature". Before the fix the absent flag fed cosign the FULL
      // Statement (double-wrap); the default must be the predicate body.
      const fed = JSON.parse(r.stdout);
      expect(fed._type).toBeUndefined();
      expect(fed.predicateType).toBeUndefined();
      expect(fed.gate_id).toBe("j-rig:server:MM-1");
      expect(fed.result).toBe("PASS");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--full-statement opts the signing path into the pre-formed Statement (nested form) [f-jrig-security-1]", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const { artifactPath, realHash, fakeCosign } = makeSigningFixture(tmpDir);
      const r = runCli([
        "emit-evidence",
        "--gate-id",
        "j-rig:server:MM-1",
        "--result",
        "PASS",
        "--input-hash",
        `sha256:${realHash}`,
        "--policy-hash",
        `sha256:${SHA}`,
        "--runner-version",
        "j-rig@0.15.0",
        "--commit-sha",
        "abc1234",
        "--key",
        "/fake.key",
        "--cosign-bin",
        fakeCosign,
        "--artifact",
        artifactPath,
        "--full-statement",
      ]);
      expect(r.code).toBe(0);
      const fed = JSON.parse(r.stdout);
      expect(fed._type).toBe("https://in-toto.io/Statement/v1");
      expect(fed.predicate.gate_id).toBe("j-rig:server:MM-1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects --full-statement combined with --predicate-body-only in signing mode [f-jrig-security-1]", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const { artifactPath, realHash, fakeCosign } = makeSigningFixture(tmpDir);
      const r = runCli([
        "emit-evidence",
        "--gate-id",
        "j-rig:server:MM-1",
        "--result",
        "PASS",
        "--input-hash",
        `sha256:${realHash}`,
        "--policy-hash",
        `sha256:${SHA}`,
        "--key",
        "/fake.key",
        "--cosign-bin",
        fakeCosign,
        "--artifact",
        artifactPath,
        "--full-statement",
        "--predicate-body-only",
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/mutually exclusive/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--output writes to file and emits an info line on stderr", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-test-"));
    try {
      const outFile = join(tmpDir, "stmt.json");
      const r = runCli([
        "emit-evidence",
        "--gate-id",
        "j-rig:server:MM-1",
        "--result",
        "PASS",
        "--input-hash",
        `sha256:${SHA}`,
        "--policy-hash",
        `sha256:${SHA}`,
        "--runner-version",
        "j-rig@0.15.0",
        "--commit-sha",
        "abc1234",
        "--output",
        outFile,
      ]);
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/wrote .*stmt.json/);
      const written = JSON.parse(readFileSync(outFile, "utf-8"));
      expect(written.predicate.gate_id).toBe("j-rig:server:MM-1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
