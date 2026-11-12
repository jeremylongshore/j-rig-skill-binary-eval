import { createHash } from "node:crypto";
import { z } from "zod";
import { parseDocument } from "yaml";
import { EvalTaskSchema, EvalConfigSchema, type RunnerRequest } from "../execution/substrate.js";

export const SCRIPTED_INPUT = "whiteglove-scripted-input/v1";
export const SCRIPTED_RESULTS = "whiteglove-scripted-results/v1";
export const SCRIPTED_LIMIT = 4 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      p.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "must be a confined relative file path",
  );
const Assertion = z
  .object({
    cmd: z.string().min(1),
    expect_exit: z.number().int().min(0).max(255),
    stdout_contains: z.string().optional(),
  })
  .strict();
export const ScriptedSourceSchema = z
  .object({
    skill_name: z.literal("whiteglove-pdf"),
    evals: z
      .array(
        z
          .object({
            id: z.number().int().safe(),
            scenario: z.string().min(1),
            prompt: z.string().min(1),
            expected_output: z.string().min(1),
            files: z.array(relativePath),
            expectations: z.array(z.string()),
            assertions: z.array(Assertion).min(1).max(4096),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict()
  .superRefine((source, ctx) => {
    const ids = new Set<number>();
    source.evals.forEach((item, index) => {
      if (ids.has(item.id))
        ctx.addIssue({
          code: "custom",
          path: ["evals", index, "id"],
          message: "duplicate case ID",
        });
      ids.add(item.id);
    });
    if (source.evals.reduce((sum, item) => sum + item.assertions.length, 0) > 4096)
      ctx.addIssue({ code: "custom", message: "too many assertions" });
  });
export type ScriptedSource = z.infer<typeof ScriptedSourceSchema>;
const Fixture = z.object({ path: relativePath, sha256: digest }).strict();
export const ScriptedInputSchema = z
  .object({
    format: z.literal(SCRIPTED_INPUT),
    source_sha256: digest,
    runner_sha256: digest,
    fixtures: z.array(Fixture),
    source: ScriptedSourceSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    const paths = [...new Set(input.source.evals.flatMap((item) => item.files ?? []))];
    if (JSON.stringify(paths) !== JSON.stringify(input.fixtures.map((f) => f.path)))
      ctx.addIssue({
        code: "custom",
        message: "fixture identity/order does not match source inputs",
      });
  });
export const ScriptedImportSchema = z
  .object({
    format: z.literal("j-rig-scripted-import/v1"),
    source_base64: z.string(),
    task: EvalTaskSchema,
    config: EvalConfigSchema,
  })
  .strict();
export type ScriptedImport = z.infer<typeof ScriptedImportSchema>;
export interface ScriptedImportOptions {
  python: string;
  runner: string;
  cwd: string;
  runnerSha256: string;
  fixtures: Array<{ path: string; sha256: string }>;
  timeoutMs: number;
}
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Pure conversion. Imported commands are data, never interpolated into argv. */
export function parseScriptedSource(bytes: Uint8Array): ScriptedSource {
  if (bytes.byteLength > SCRIPTED_LIMIT) throw new Error("source exceeds 4 MiB");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  const parsed = parseDocument(text, { uniqueKeys: true });
  if (parsed.errors.length) throw new Error("source JSON contains duplicate or unsupported keys");
  return ScriptedSourceSchema.parse(value);
}
export function importScriptedEvals(
  bytes: Uint8Array,
  options: ScriptedImportOptions,
): ScriptedImport {
  if (bytes.byteLength > SCRIPTED_LIMIT) throw new Error("source exceeds 4 MiB");
  const source = parseScriptedSource(bytes);
  const input = ScriptedInputSchema.parse({
    format: SCRIPTED_INPUT,
    source_sha256: sha256Bytes(bytes),
    runner_sha256: options.runnerSha256,
    fixtures: options.fixtures,
    source,
  });
  const identity = sha256Bytes(Buffer.from(JSON.stringify(input)));
  const normalizedConfig = EvalConfigSchema.parse({
    id: "pending-identity",
    version: "1",
    model: "authored-script",
    parameters: { protocol: SCRIPTED_RESULTS },
    harness: {
      command: options.python,
      args: [options.runner, "--structured"],
      cwd: options.cwd,
      env: {},
      timeout_ms: options.timeoutMs,
      max_output_bytes: SCRIPTED_LIMIT,
      completed_exit_codes: [0, 1],
    },
  });
  const configuration = {
    version: normalizedConfig.version,
    model: normalizedConfig.model,
    parameters: normalizedConfig.parameters,
    harness: normalizedConfig.harness,
    tags: normalizedConfig.tags,
  };
  const configIdentity = sha256Bytes(
    Buffer.from(JSON.stringify({ input_identity: identity, ...configuration })),
  );
  const imported = ScriptedImportSchema.parse({
    format: "j-rig-scripted-import/v1",
    source_base64: Buffer.from(bytes).toString("base64"),
    task: {
      id: `scripted-${identity}`,
      version: "1",
      description:
        "Run the explicitly selected authored assertion suite; descriptive expectations are not graded.",
      input,
    },
    config: { ...configuration, id: `scripted-runner-${configIdentity}` },
  });
  const maximumRequest = {
    run_id: `raw_${"f".repeat(64)}`,
    task: imported.task,
    config: imported.config,
    model: imported.config.model,
    sample_index: Number.MAX_SAFE_INTEGER,
  };
  if (Buffer.byteLength(JSON.stringify(maximumRequest)) > SCRIPTED_LIMIT)
    throw new Error("serialized authored-runner request exceeds 4 MiB");
  return imported;
}
/** Bind to saved request, never identities obtained from the producer's receipt. */
export function validateScriptedRequest(value: unknown, imported: ScriptedImport): RunnerRequest {
  const request = z
    .object({
      run_id: z.string().min(1),
      task: EvalTaskSchema,
      config: EvalConfigSchema,
      model: z.literal("authored-script"),
      sample_index: z.number().int().min(0),
    })
    .strict()
    .parse(value);
  const input = ScriptedInputSchema.parse(request.task.input);
  const bytes = Buffer.from(imported.source_base64, "base64");
  if (
    bytes.toString("base64") !== imported.source_base64 ||
    sha256Bytes(bytes) !== input.source_sha256 ||
    JSON.stringify(parseScriptedSource(bytes)) !== JSON.stringify(input.source)
  )
    throw new Error("import source bytes do not match the saved source identity");
  if (
    JSON.stringify(request.task) !== JSON.stringify(imported.task) ||
    JSON.stringify(request.config) !== JSON.stringify(imported.config)
  )
    throw new Error("stored request does not match the imported task/config");
  return request;
}

/** Imported-lane bounds only; generic runner policy is unchanged. */
export function assertScriptedRunAdmission(request: RunnerRequest): void {
  if (!Number.isSafeInteger(request.sample_index) || request.sample_index < 0)
    throw new Error("scripted sample index must be a non-negative safe integer");
  if (!/^raw_[a-f0-9]{64}$(?![\s\S])/.test(request.run_id))
    throw new Error("scripted Run must use the generic derived SHA256 identity");
  ScriptedInputSchema.parse(request.task.input);
  if (Buffer.byteLength(JSON.stringify(request)) > SCRIPTED_LIMIT)
    throw new Error("serialized authored-runner request exceeds 4 MiB");
}
