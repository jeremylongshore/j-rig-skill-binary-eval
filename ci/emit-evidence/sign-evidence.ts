/** Exact-v1 nightly producer. Private signing is offline; public keyless signing
 * runs the existing DNSSEC/CAA preflight before requesting credentials or logs.
 * DSSE encoding and bundle construction belong to the pinned Sigstore library.
 */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import childProcess from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bundleToJSON } from "@sigstore/bundle";
import {
  CIContextProvider,
  DSSEBundleBuilder,
  FulcioSigner,
  RekorWitness,
  type BundleBuilder,
} from "@sigstore/sign";
import { EvidenceBundlePayloadSchema } from "@intentsolutions/core/validators/v1/evidence-statement";
import { stableStringify } from "./emit-evidence.ts";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROW_BYTES = 4 * 1024 * 1024;
const PAYLOAD_TYPE = "application/vnd.in-toto+json";
const EMPTY_ARTIFACT_BYTES = Buffer.byteLength(
  JSON.stringify({ format: "sigstore-dsse-rows/v1", rows: [] }) + "\n",
);
// A strict lower bound: signatures, mediaType, certificates and proofs add bytes.
const MIN_ENVELOPE_BYTES = Buffer.byteLength(
  JSON.stringify({ dsseEnvelope: { payloadType: PAYLOAD_TYPE, payload: "", signatures: [] } }),
);

function appendRowBytes(current: number, rowBytes: number, existingRows: number): number {
  return current + rowBytes + (existingRows === 0 ? 0 : 1);
}

/** Reject unavoidable base64/container expansion before any signing effects.
 * Passing this lower bound does not predict variable certificate/proof overhead.
 */
function requireMinimumSizes(rows: readonly Buffer[]): void {
  if (rows.length === 0 || rows.length > 256)
    throw new Error("expected 1 to 256 evidence Statements");
  let total = EMPTY_ARTIFACT_BYTES;
  for (const [index, row] of rows.entries()) {
    const minimum = MIN_ENVELOPE_BYTES + 4 * Math.ceil(row.length / 3);
    if (minimum > MAX_ROW_BYTES) throw new Error("minimum signed row exceeds consumer limit");
    total = appendRowBytes(total, minimum, index);
    if (total > MAX_BYTES) throw new Error("minimum signed artifact exceeds consumer limit");
  }
}
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readPayload(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("input is not a bounded regular file");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_BYTES) throw new Error("input grew beyond artifact limit");
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Validate the whole input before making the first signing request. */
export function statementBytes(raw: unknown): Buffer[] {
  EvidenceBundlePayloadSchema.parse(raw);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 256)
    throw new Error("expected 1 to 256 evidence Statements");
  const bytes = raw.map((row: unknown) => Buffer.from(stableStringify(row)));
  requireMinimumSizes(bytes);
  return bytes;
}

export function privateBuilder(pem: string, keyHint: string): BundleBuilder {
  if (!keyHint.trim()) throw new Error("private signing requires an external key hint");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("private signing requires an enrolled P-256 key");
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return new DSSEBundleBuilder({
    signer: {
      async sign(data) {
        return {
          signature: sign("sha256", data, key),
          key: { $case: "publicKey", publicKey, hint: keyHint },
        };
      },
    },
    witnesses: [],
  });
}

/** Production mode is explicit; there is no DNS or logging opt-out. */
export function keylessBuilder(): BundleBuilder {
  for (const script of ["dnssec-check.sh", "caa-check.sh"]) {
    childProcess.execFileSync(
      "bash",
      [resolve(REPO, ".audit-harness/scripts", script), "evals.intentsolutions.io"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        // Use the established production resolver and CA defaults, not fixture
        // command overrides or the preflight's permissive ANY-issuer option.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          EXPECTED_CAA_ISSUER: "letsencrypt.org",
        },
      },
    );
  }
  return new DSSEBundleBuilder({
    signer: new FulcioSigner({
      identityProvider: new CIContextProvider("sigstore"),
      retry: 0,
      timeout: 10_000,
    }),
    witnesses: [new RekorWitness({ entryType: "dsse", retry: 0, timeout: 10_000 })],
  });
}

export async function signStatements(
  bytes: readonly Buffer[],
  builder: BundleBuilder,
  requireInclusion: boolean,
) {
  requireMinimumSizes(bytes);
  const rows: unknown[] = [];
  let total = EMPTY_ARTIFACT_BYTES;
  for (const data of bytes) {
    const bundle = await builder.create({ data, type: PAYLOAD_TYPE });
    const row = bundleToJSON(bundle);
    const serializedBytes = Buffer.byteLength(JSON.stringify(row));
    if (serializedBytes > MAX_ROW_BYTES) throw new Error("signed row exceeds consumer limit");
    total = appendRowBytes(total, serializedBytes, rows.length);
    if (total > MAX_BYTES) throw new Error("signed artifact exceeds consumer limit");
    const entries = bundle.verificationMaterial.tlogEntries;
    if (
      requireInclusion &&
      (entries.length === 0 || entries.some((entry) => !entry.inclusionProof?.checkpoint?.envelope))
    )
      throw new Error("signing service did not return required inclusion proof and checkpoint");
    rows.push(row);
  }
  const result = JSON.stringify({ format: "sigstore-dsse-rows/v1", rows }) + "\n";
  if (Buffer.byteLength(result) > MAX_BYTES)
    throw new Error("signed artifact exceeds consumer limit");
  return result;
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string" },
      "private-key": { type: "string" },
      "key-hint": { type: "string" },
      keyless: { type: "boolean" },
    },
  });
  if (
    !values.output ||
    positionals.length !== 1 ||
    Boolean(values["private-key"]) === Boolean(values.keyless)
  )
    throw new Error(
      "use --output FILE and exactly one of --private-key FILE or --keyless with one evidence-payload input",
    );
  if (values.keyless && values["key-hint"])
    throw new Error("key hints are only valid for private signing");
  const raw = readPayload(positionals[0]!);
  if (raw.length > MAX_BYTES) throw new Error("input exceeds artifact limit");
  const bytes = statementBytes(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
  const builder = values.keyless
    ? keylessBuilder()
    : privateBuilder(readFileSync(values["private-key"]!, "utf8"), values["key-hint"] ?? "");
  const result = await signStatements(bytes, builder, Boolean(values.keyless));
  const target = resolve(values.output);
  const temporaryDirectory = mkdtempSync(join(dirname(target), ".signed-evidence-"));
  const temporary = join(temporaryDirectory, "artifact.json");
  try {
    writeFileSync(temporary, result, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    // Never include service responses, key contents or OIDC tokens in diagnostics.
    console.error("sign-evidence failed; no complete signed artifact was published");
    process.exitCode = 1;
  });
}
