import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import childProcess, { type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { bundleToJSON } from "@sigstore/bundle";
import { DSSEBundleBuilder } from "@sigstore/sign";
import { buildRows, stableStringify, writeEmit } from "../emit-evidence.ts";
import {
  keylessBuilder,
  main,
  privateBuilder,
  signStatements,
  statementBytes,
} from "../sign-evidence.ts";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const rows = buildRows(
  [
    {
      gateName: "synthetic-producer",
      gateVersion: "1.0.0",
      decision: "pass",
      reasons: ["synthetic fixture outcome"],
      dimensionsEvaluated: ["functional-criteria"],
      dimensionsSkipped: [],
      specSha256: "c".repeat(64),
      skillPath: "fixtures/synthetic-skill",
      skillsCommit: "a".repeat(40),
    },
  ],
  {
    nowIso: "2026-11-11T00:00:00.000Z",
    nowMs: Date.parse("2026-11-11T00:00:00Z"),
    sourceSha: "b".repeat(40),
    runnerVersion: "1.0.0",
    rand16: () => new Uint8Array(16),
  },
);
const payload = rows[0]!.evidencePayload;

test("uses the actual nightly emitter's exact canonical v1 Statement bytes", async () => {
  const input = statementBytes(payload);
  assert.equal(input[0]!.toString(), stableStringify(payload[0]));
  const output = JSON.parse(
    await signStatements(input, privateBuilder(pem, "synthetic-key"), false),
  );
  assert.equal(output.format, "sigstore-dsse-rows/v1");
  assert.equal(
    Buffer.from(output.rows[0].dsseEnvelope.payload, "base64").toString(),
    input[0]!.toString(),
  );
  assert.equal(payload[0]!.subject[0]!.name, "jrig:ci:synthetic-producer");
  assert.equal((output.rows[0].verificationMaterial.tlogEntries ?? []).length, 0);
});

test("rejects malformed, empty and legacy payloads before signing", () => {
  for (const value of [
    [],
    {},
    [{ ...payload[0], _type: "https://in-toto.io/Statement/v0.1" }],
    [{ ...payload[0], predicate: {} }],
  ])
    assert.throws(() => statementBytes(value));
});

test("private signing requires explicit external key identity and supported primitive", () => {
  assert.throws(() => privateBuilder(pem, ""), /key hint/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      privateBuilder(
        rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        "synthetic",
      ),
    /P-256/,
  );
});

test("production keyless construction runs both fixed preflights before any service call", (context) => {
  const calls: string[][] = [];
  context.mock.method(
    childProcess,
    "execFileSync",
    (_command: string, args: string[], options: { env: Record<string, string> }) => {
      calls.push(args);
      assert.equal(options.env.EXPECTED_CAA_ISSUER, "letsencrypt.org");
      assert.equal(options.env.DNSSEC_CHECK_DIG_CMD, undefined);
      return Buffer.alloc(0);
    },
  );
  assert.ok(keylessBuilder() instanceof DSSEBundleBuilder);
  assert.equal(calls.length, 2);
  assert.match(calls[0]![0]!, /dnssec-check\.sh$/);
  assert.match(calls[1]![0]!, /caa-check\.sh$/);
  assert.equal(calls[0]![1], "evals.intentsolutions.io");
});

test("failed production preflight stops before a signing service request", (context) => {
  const call = context.mock.method(childProcess, "execFileSync", () => {
    throw new Error("synthetic preflight refusal");
  });
  assert.throws(() => keylessBuilder(), /preflight refusal/);
  assert.equal(call.mock.callCount(), 1);
});

test("keyless output requires a real proof and checkpoint, not just a signature", async () => {
  await assert.rejects(
    signStatements(statementBytes(payload), privateBuilder(pem, "synthetic-key"), true),
    /required inclusion proof/,
  );
});

function parseOutputs(text: string): Map<string, string> {
  const lines = text.split("\n");
  const output = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const [key, marker] = lines[i]!.split("<<");
    if (!marker) continue;
    const value: string[] = [];
    while (++i < lines.length && lines[i] !== marker) value.push(lines[i]!);
    output.set(key!, value.join("\n"));
  }
  return output;
}

test("real emitter files and producer CLI interoperate with the enforcing bundled Action", async () => {
  const action = process.env.ROLLOUT_GATE_DIST;
  assert.ok(action, "ROLLOUT_GATE_DIST must name the separately built enforcing Action");
  const dir = mkdtempSync(join(tmpdir(), "jrig-sign-interop-"));
  try {
    writeEmit(rows, "refs/heads/main", dir);
    const key = join(dir, "ephemeral.pem");
    writeFileSync(key, pem, { mode: 0o600 });
    const signed = join(dir, "signed.json");
    await main([
      "--private-key",
      key,
      "--key-hint",
      "synthetic-key",
      "--output",
      signed,
      join(dir, "evidence-payload-0.json"),
    ]);
    const trust = JSON.stringify({
      kind: "key",
      keyHint: "synthetic-key",
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      status: "active",
      notBefore: "2020-01-01T00:00:00Z",
      notAfter: "2099-01-01T00:00:00Z",
      requireInclusion: false,
    });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("INPUT_") && !key.startsWith("GITHUB_"),
      ),
    );
    for (const tampered of [false, true]) {
      if (tampered) {
        const body = JSON.parse(readFileSync(signed, "utf8"));
        body.rows[0].dsseEnvelope.payload = Buffer.from("{}").toString("base64");
        writeFileSync(signed, JSON.stringify(body));
      }
      const output = join(dir, `outputs-${tampered}`);
      writeFileSync(output, "");
      const result: SpawnSyncReturns<string> = childProcess.spawnSync(
        process.execPath,
        [resolve(action)],
        {
          encoding: "utf8",
          env: {
            ...env,
            NODE_OPTIONS: `--experimental-strip-types --import ${fileURLToPath(new URL("./deny-network.ts", import.meta.url))}`,
            GITHUB_OUTPUT: output,
            "INPUT_BUNDLE-PATH": signed,
            "INPUT_POLICY-JSON": JSON.stringify({ required_gates: ["jrig:ci:*"] }),
            "INPUT_VERIFICATION-POLICY-JSON": trust,
          },
        },
      );
      assert.equal(result.status, tampered ? 1 : 0);
      const values = parseOutputs(readFileSync(output, "utf8"));
      assert.equal(values.get("decision"), tampered ? "block" : "allow");
      assert.equal(values.get("verification-status"), tampered ? "failed" : "verified");
      assert.equal(
        values.get("verification-transparency"),
        tampered ? "not-verified" : "contains-private-unanchored",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ROW_LIMIT = 4 * 1024 * 1024;
const ARTIFACT_LIMIT = 16 * 1024 * 1024;

function paddedResponseBuilder(targets: number[]) {
  const real = privateBuilder(pem, "synthetic-key");
  let calls = 0;
  return {
    calls: () => calls,
    builder: {
      async create(artifact: Parameters<typeof real.create>[0]) {
        const bundle = await real.create(artifact);
        const key = bundle.verificationMaterial.content;
        assert.equal(key?.$case, "publicKey");
        if (key?.$case !== "publicKey") throw new Error("expected private fixture");
        const before = Buffer.byteLength(JSON.stringify(bundleToJSON(bundle)));
        const target = targets[calls++]!;
        key.publicKey.hint = "x".repeat((key.publicKey.hint?.length ?? 0) + target - before);
        return bundle;
      },
    },
  };
}

test("known oversized canonical row is rejected before public preflight or signing", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-oversize-row-"));
  const preflight = context.mock.method(childProcess, "execFileSync", () => {
    throw new Error("unexpected preflight");
  });
  try {
    const large = [
      {
        ...payload[0],
        predicate: { ...payload[0]!.predicate, metadata: { padding: "a".repeat(3_200_000) } },
      },
    ];
    const input = join(directory, "input.json");
    writeFileSync(input, JSON.stringify(large));
    await assert.rejects(
      main(["--keyless", "--output", join(directory, "output.json"), input]),
      /minimum signed row exceeds/,
    );
    assert.equal(preflight.mock.callCount(), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("known aggregate base64 expansion rejects before the first builder effect", async () => {
  const bytes = Buffer.from(
    stableStringify({
      ...payload[0],
      predicate: { ...payload[0]!.predicate, metadata: { padding: "a".repeat(2_600_000) } },
    }),
  );
  let calls = 0;
  await assert.rejects(
    signStatements(
      Array.from({ length: 5 }, () => bytes),
      {
        async create() {
          calls++;
          throw new Error("unexpected builder");
        },
      },
      false,
    ),
    /minimum signed artifact exceeds/,
  );
  assert.equal(calls, 0);
});

test("actual serialized row limit accepts equality and rejects variable overhead beyond it", async () => {
  const exact = paddedResponseBuilder([ROW_LIMIT]);
  const output = JSON.parse(await signStatements(statementBytes(payload), exact.builder, false));
  assert.equal(Buffer.byteLength(JSON.stringify(output.rows[0])), ROW_LIMIT);
  const oversized = paddedResponseBuilder([ROW_LIMIT + 1]);
  await assert.rejects(
    signStatements(statementBytes(payload), oversized.builder, false),
    /signed row exceeds consumer limit/,
  );
  assert.equal(oversized.calls(), 1);
});

test("actual aggregate overflow stops before further builder effects", async () => {
  const response = paddedResponseBuilder(Array.from({ length: 6 }, () => ROW_LIMIT));
  await assert.rejects(
    signStatements(
      Array.from({ length: 6 }, () => statementBytes(payload)[0]!),
      response.builder,
      false,
    ),
    /signed artifact exceeds consumer limit/,
  );
  assert.equal(response.calls(), 4);
});

test("actual aggregate accounting includes commas and the final newline and accepts equality", async () => {
  const emptyBytes = Buffer.byteLength(
    JSON.stringify({ format: "sigstore-dsse-rows/v1", rows: [] }) + "\n",
  );
  const response = paddedResponseBuilder([
    ROW_LIMIT,
    ROW_LIMIT,
    ROW_LIMIT,
    ROW_LIMIT - emptyBytes - 3,
  ]);
  const output = await signStatements(
    Array.from({ length: 4 }, () => statementBytes(payload)[0]!),
    response.builder,
    false,
  );
  assert.equal(Buffer.byteLength(output), ARTIFACT_LIMIT);
  assert.equal(output.endsWith("\n"), true);
});
