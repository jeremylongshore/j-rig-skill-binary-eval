import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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

const CLI_PATH = join(__dirname, "../../dist/index.js");

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("node", [CLI_PATH, ...args], { encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
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
      "--key",
      "/nonexistent.key",
      "--cosign-bin",
      "/nonexistent/cosign-binary",
    ]);
    // Exit 2 when cosign binary cannot be spawned.
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/failed to spawn cosign/);
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
