import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEmitEvidenceCommand } from "./emit-evidence.js";

const roots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;
const direct = [
  "--gate-id",
  "synth:ci:unit",
  "--gate-decision",
  "pass",
  "--gate-name",
  "emit-check",
  "--gate-version",
  "2.0.0",
  "--policy-ref",
  `${digest}:policy.json`,
  "--policy-hash",
  digest,
  "--input-hash",
  digest,
  "--commit-sha",
  "abc1234",
];

beforeEach(() => {
  vi.stubEnv("AUDIT_HARNESS_OTEL", "0");
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory() {
  const root = mkdtempSync(join(tmpdir(), "jrig-emit-command-"));
  roots.push(root);
  return root;
}

async function invoke(args: string[]) {
  // Returning from the terminal boundary lets the real registered handler run
  // in the instrumented worker. Existing subprocess tests prove actual exits.
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const program = new Command();
    registerEmitEvidenceCommand(program);
    await program.parseAsync(["emit-evidence", ...args], { from: "user" });
    return {
      exits: exit.mock.calls.map(([code]) => code),
      stdout: stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
      stderr: stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
    };
  } finally {
    exit.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

it("emits a full statement once with ordered dimensions, metadata and truthful identity", async () => {
  const result = await invoke([
    ...direct,
    "--gate-reason",
    "first",
    "--gate-reason",
    "second",
    "--coverage-evaluated",
    "unit",
    "--coverage-evaluated",
    "types",
    "--coverage-skipped",
    "mutation",
    "--metadata",
    '{"fixture":true}',
  ]);
  expect(result.exits).toEqual([0]);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    subject: [{ digest: { sha256: "a".repeat(64) } }],
    predicate: {
      gate_id: "synth:ci:unit",
      gate_decision: "pass",
      commit_sha: "abc1234",
      gate_reasons: ["first", "second"],
      metadata: { fixture: true },
      coverage: { dimensions_evaluated: ["unit", "types"], dimensions_skipped: ["mutation"] },
    },
  });
});

it("writes a pipeline predicate to a new directory and reports OTel only on stderr", async () => {
  const root = directory();
  const input = join(root, "input.json");
  const output = join(root, "nested", "predicate.json");
  writeFileSync(
    input,
    JSON.stringify({
      gate_id: "synth:ci:unit",
      gate_decision: "pass",
      gate_name: "emit-check",
      gate_version: "2.0.0",
      gate_reasons: ["measured"],
      policy_ref: `${digest}:policy.json`,
      policy_hash: digest,
      input_hash: digest,
    }),
  );
  vi.stubEnv("AUDIT_HARNESS_OTEL", "1");
  const result = await invoke(["--input", input, "--output", output, "--predicate-body-only"]);
  expect(result.exits).toEqual([0]);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("[OTEL]");
  expect(result.stderr).toContain("emit-evidence: wrote");
  const body = JSON.parse(readFileSync(output, "utf8"));
  expect(body).toMatchObject({ gate_id: "synth:ci:unit", gate_reasons: ["measured"] });
  expect(body.commit_sha).toMatch(/^[a-f0-9]{40}$/);
  expect(body).not.toHaveProperty("predicate");
});

it.each(["[]", "null", "{"])("refuses invalid metadata %s before output", async (metadata) => {
  const result = await invoke([...direct, "--metadata", metadata]);
  expect(result.exits).toEqual([1]);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("--metadata is not a valid JSON object");
});

it("refuses incomplete direct flags without waiting on stdin", async () => {
  const before = process.stdin.listenerCount("data");
  const result = await invoke(["--gate-name", "emit-check"]);
  expect(result.exits).toEqual([1]);
  expect(result.stderr).toContain("direct mode requires:");
  expect(process.stdin.listenerCount("data")).toBe(before);
});

it("refuses malformed input JSON before creating output", async () => {
  const input = join(directory(), "bad.json");
  writeFileSync(input, "{");
  const result = await invoke(["--input", input]);
  expect(result.exits).toEqual([1]);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("input is not valid JSON");
});

function signingFixture() {
  const root = directory();
  const artifact = join(root, "artifact.txt");
  const bytes = "fixture artifact\n";
  writeFileSync(artifact, bytes);
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const executable = join(root, "transport.cjs");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const predicate = JSON.parse(fs.readFileSync(args[args.indexOf("--predicate") + 1]));',
      'fs.writeFileSync(args[args.indexOf("--output-signature") + 1], JSON.stringify({args, predicate}));',
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  const args = [...direct];
  args[args.indexOf("--input-hash") + 1] = hash;
  return { artifact, hash, executable, args };
}

it.each([false, true])(
  "passes the exact chosen predicate to the signing transport (full=%s)",
  async (full) => {
    const f = signingFixture();
    const result = await invoke([
      ...f.args,
      "--key",
      "fixture-key",
      "--artifact",
      f.artifact,
      "--cosign-bin",
      f.executable,
      ...(full ? ["--full-statement"] : []),
    ]);
    expect(result.exits).toEqual([0]);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.args).toContain("attest-blob");
    expect(receipt.args).toContain("--tlog-upload=false");
    expect(receipt.args.at(-1)).toBe(f.artifact);
    const predicate = full ? receipt.predicate.predicate : receipt.predicate;
    expect(predicate.input_hash).toBe(f.hash);
    expect(predicate.gate_id).toBe("synth:ci:unit");
    // This fixture checks transport arguments and bytes, not cryptographic signing.
    expect(result.stderr).toContain("signed envelope emitted");
  },
);

it("rejects mismatched artifact bytes before spawning the signing transport", async () => {
  const f = signingFixture();
  const result = await invoke([
    ...direct,
    "--key",
    "fixture-key",
    "--artifact",
    f.artifact,
    "--cosign-bin",
    join(directory(), "must-not-run"),
  ]);
  expect(result.exits).toEqual([1]);
  expect(result.stderr).toContain("--artifact sha256 mismatch");
  expect(result.stdout).toBe("");
});

it("preserves the signing executable failure exit code", async () => {
  const f = signingFixture();
  const result = await invoke([
    ...f.args,
    "--key",
    "fixture-key",
    "--artifact",
    f.artifact,
    "--cosign-bin",
    join(directory(), "missing"),
  ]);
  expect(result.exits).toEqual([2]);
  expect(result.stderr).toContain("failed to spawn cosign");
});

it.each([
  { args: ["--sign"], message: "requires --key" },
  { args: ["--key", "fixture-key"], message: "requires --artifact" },
  {
    args: ["--key", "fixture-key", "--full-statement", "--predicate-body-only"],
    message: "mutually exclusive",
  },
])("refuses signing preconditions: $message", async ({ args, message }) => {
  const result = await invoke([...direct, ...args]);
  expect(result.exits).toEqual([1]);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
});

it("refuses an unsuccessful signing transport without emitting a receipt", async () => {
  const f = signingFixture();
  writeFileSync(f.executable, "#!/usr/bin/env node\nprocess.exit(9);\n");
  const result = await invoke([
    ...f.args,
    "--key",
    "fixture-key",
    "--artifact",
    f.artifact,
    "--cosign-bin",
    f.executable,
  ]);
  expect(result.exits).toEqual([3]);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("cosign signing failed (exit 9)");
});
