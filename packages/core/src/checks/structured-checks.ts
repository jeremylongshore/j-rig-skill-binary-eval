import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";
import type { ExecutionOutput } from "../execution/types.js";

/**
 * Structured checks — deterministic criteria over a process exit code, a JSON
 * document, or a produced file's bytes, rather than substring tests on text.
 *
 *   exit_code    — the observed process exit code equals `equals`.
 *   json_path    — a JSONPath into a JSON document: `exists`, `equals`, or a
 *                  scalar value `matches` a regex.
 *   file_sha256  — a file the run produced or left has exactly this sha256.
 *   schema_valid — a JSON document validates against an inline JSON Schema,
 *                  pinned to draft 2020-12.
 *
 * Two surfaces grade with them:
 *   - `j-rig eval` criteria (`method: deterministic`, `deterministic_check:
 *     json_path`, params in `deterministic_check_params`). The JSON document
 *     is the response text, or with `file:` a text file the claude-code
 *     execution provider observed the run produce. `exit_code` is refused
 *     there at spec load: a skill case has no process exit code.
 *   - `j-rig grade` deterministic graders over a sealed command run
 *     (`j-rig run`): the document is stdout, `exit_code` is the run's exit
 *     code, and `file_sha256` reads the run's artifact manifest. File CONTENT
 *     is not sealed for command runs, so `json_path`/`schema_valid` with
 *     `file:` fail closed there.
 *
 * Params are validated at spec load (schema compiled, JSONPath parsed, regex
 * compiled), so a typo fails `j-rig validate` before any model spend. Every
 * check fails CLOSED when the thing it reads was not observed.
 */

/** The only JSON Schema dialect accepted; a schema may omit `$schema` or name this one. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

// ── JSONPath (deliberately small, single-value subset) ────────────────────

/** One step of a parsed path: an object key or an array index. */
export type JsonPathSegment = { key: string } | { index: number };

/**
 * Parse the supported JSONPath subset: `$` followed by `.name`, `['name']`,
 * `["name"]` or `[n]` steps. No wildcards, slices, filters or recursive
 * descent: a check asserts on exactly one value, so a path must name one.
 * Returns the segments, or an error message.
 */
export function parseJsonPath(path: string): JsonPathSegment[] | string {
  if (!path.startsWith("$")) return "a JSONPath must start with `$`";
  const segments: JsonPathSegment[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(path.slice(i + 1));
      if (!m) return `expected a property name after "." at offset ${i}`;
      segments.push({ key: m[0] });
      i += 1 + m[0].length;
    } else if (ch === "[") {
      const rest = path.slice(i);
      const idx = /^\[(0|[1-9][0-9]*)\]/.exec(rest);
      if (idx) {
        segments.push({ index: Number(idx[1]) });
        i += idx[0].length;
        continue;
      }
      const quoted = /^\[(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\]/.exec(rest);
      if (!quoted) {
        return (
          `unsupported step at offset ${i}: only [n], ['key'] and ["key"] are allowed ` +
          `(no wildcards, slices or filters)`
        );
      }
      const raw = quoted[1] ?? quoted[2] ?? "";
      segments.push({ key: raw.replace(/\\(.)/g, "$1") });
      i += quoted[0].length;
    } else {
      return `unexpected "${ch}" at offset ${i}`;
    }
  }
  return segments;
}

/** Resolve a parsed path; `found: false` when any step is missing. */
export function resolveJsonPath(
  doc: unknown,
  segments: readonly JsonPathSegment[],
): { found: true; value: unknown } | { found: false } {
  let cur: unknown = doc;
  for (const s of segments) {
    if ("index" in s) {
      if (!Array.isArray(cur) || s.index >= cur.length) return { found: false };
      cur = cur[s.index];
    } else {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return { found: false };
      if (!Object.prototype.hasOwnProperty.call(cur, s.key)) return { found: false };
      cur = (cur as Record<string, unknown>)[s.key];
    }
  }
  return { found: true, value: cur };
}

/** Structural JSON equality (key order irrelevant, array order significant). */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEquals(v, b[i]));
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    if (ak.length !== Object.keys(bo).length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && jsonEquals(ao[k], bo[k]));
  }
  return false;
}

// ── JSON Schema (draft 2020-12, pinned) ───────────────────────────────────

/**
 * Compile a schema with a fresh Ajv 2020-12 instance. Strict schema mode
 * rejects unknown keywords (a misspelled keyword must not silently validate
 * everything).
 * `format` stays an annotation, which is the 2020-12 default: no format
 * vocabulary is loaded, so format assertions are deliberately not checked.
 * Remote `$ref`s cannot resolve (no loader), so they fail at compile time.
 */
const compiledSchemas = new Map<string, ValidateFunction | string>();

export function compileJsonSchema(schema: unknown): ValidateFunction | string {
  // Spec load and every graded case compile the same schema; memoize on its
  // canonical text so a large spec does not recompile per case.
  const key = JSON.stringify(schema) ?? "undefined";
  const cached = compiledSchemas.get(key);
  if (cached !== undefined) return cached;
  const compiled = compileUncached(schema);
  if (compiledSchemas.size >= 256) compiledSchemas.clear();
  compiledSchemas.set(key, compiled);
  return compiled;
}

function compileUncached(schema: unknown): ValidateFunction | string {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return "`schema` must be a JSON Schema object";
  }
  const declared = (schema as Record<string, unknown>)["$schema"];
  if (declared !== undefined && declared !== JSON_SCHEMA_DIALECT) {
    return `\`schema.$schema\` must be "${JSON_SCHEMA_DIALECT}" (draft 2020-12 is pinned), got ${JSON.stringify(declared)}`;
  }
  try {
    // strictSchema only: an unknown keyword is an author error, but the
    // stylistic strict rules (strictRequired, strictTypes, strictTuples)
    // reject schemas that are valid 2020-12, so they stay off.
    const ajv = new Ajv2020({
      strict: false,
      strictSchema: true,
      allErrors: true,
      validateFormats: false,
    });
    return ajv.compile(schema as Record<string, unknown>);
  } catch (err) {
    return `\`schema\` is not a valid draft 2020-12 JSON Schema: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Param schemas ─────────────────────────────────────────────────────────

/** A workspace-relative path: no absolute paths, no `..` escapes. */
const RelativePath = z
  .string()
  .min(1)
  .refine(
    (v) => !v.startsWith("/") && !v.split("/").includes(".."),
    "must be a workspace-relative path without `..`",
  );

const ExitCodeShape = {
  equals: z.number().int().min(0).max(255).describe("Required process exit code"),
};

const JsonPathShape = {
  path: z.string().min(1).describe("JSONPath subset: $, .key, ['key'], [n]"),
  file: RelativePath.optional().describe(
    "Read this produced text file instead of the response text / stdout",
  ),
  exists: z.boolean().optional().describe("The path resolves (true) or does not (false)"),
  equals: z.unknown().optional().describe("The value at the path equals this JSON value"),
  matches: z.string().min(1).optional().describe("Regex over a string/number/boolean value"),
};

const FileSha256Shape = {
  path: RelativePath.describe("Workspace- or run-relative file path"),
  sha256: z
    .string()
    .regex(
      /^(sha256:)?[a-f0-9]{64}$/,
      "must be 64 lowercase hex chars, optionally sha256:-prefixed",
    )
    .describe("Expected sha256 of the file's final bytes"),
};

const SchemaValidShape = {
  schema: z.record(z.string(), z.unknown()).describe("Inline JSON Schema (draft 2020-12)"),
  file: RelativePath.optional().describe(
    "Validate this produced text file instead of the response text / stdout",
  ),
};

type Issue = { message: string; path?: string };

function jsonPathIssues(v: {
  path: string;
  exists?: boolean;
  equals?: unknown;
  matches?: string;
}): Issue[] {
  const issues: Issue[] = [];
  const parsed = parseJsonPath(v.path);
  if (typeof parsed === "string")
    issues.push({ message: `invalid JSONPath: ${parsed}`, path: "path" });
  // `equals: null` is a real assertion (the value is JSON null), so presence
  // is "key present", not "value defined".
  const modes = [
    v.exists !== undefined,
    Object.prototype.hasOwnProperty.call(v, "equals"),
    v.matches !== undefined,
  ].filter(Boolean).length;
  if (modes !== 1) {
    issues.push({ message: "exactly one of `exists`, `equals` or `matches` is required" });
  }
  if (v.matches !== undefined) {
    try {
      new RegExp(v.matches);
    } catch {
      issues.push({ message: "`matches` is not a valid regular expression", path: "matches" });
    }
  }
  return issues;
}

function schemaValidIssues(v: { schema: Record<string, unknown> }): Issue[] {
  const compiled = compileJsonSchema(v.schema);
  return typeof compiled === "string" ? [{ message: compiled, path: "schema" }] : [];
}

function addIssues(issues: Issue[], ctx: z.RefinementCtx): void {
  for (const i of issues) {
    ctx.addIssue({ code: "custom", message: i.message, ...(i.path ? { path: [i.path] } : {}) });
  }
}

export const STRUCTURED_CHECK_PARAM_SCHEMAS = {
  exit_code: z.object(ExitCodeShape).strict(),
  json_path: z
    .object(JsonPathShape)
    .strict()
    .superRefine((v, ctx) => addIssues(jsonPathIssues(v), ctx)),
  file_sha256: z.object(FileSha256Shape).strict(),
  schema_valid: z
    .object(SchemaValidShape)
    .strict()
    .superRefine((v, ctx) => addIssues(schemaValidIssues(v), ctx)),
} as const;

export type StructuredCheckName = keyof typeof STRUCTURED_CHECK_PARAM_SCHEMAS;
export const STRUCTURED_CHECK_NAMES = Object.keys(
  STRUCTURED_CHECK_PARAM_SCHEMAS,
) as StructuredCheckName[];

export function isStructuredCheck(name: string): name is StructuredCheckName {
  return Object.prototype.hasOwnProperty.call(STRUCTURED_CHECK_PARAM_SCHEMAS, name);
}

/**
 * The same four checks as `j-rig grade` grader check entries: `id`, `type`,
 * `required`, then the check's params flattened beside them.
 */
const graderBase = (type: StructuredCheckName) => ({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe evaluation identifier"),
  type: z.literal(type),
  required: z.boolean().default(true),
});

export const STRUCTURED_GRADER_CHECK_SCHEMAS = [
  z.object({ ...graderBase("exit_code"), ...ExitCodeShape }).strict(),
  z
    .object({ ...graderBase("json_path"), ...JsonPathShape })
    .strict()
    .superRefine((v, ctx) => addIssues(jsonPathIssues(v), ctx)),
  z.object({ ...graderBase("file_sha256"), ...FileSha256Shape }).strict(),
  z
    .object({ ...graderBase("schema_valid"), ...SchemaValidShape })
    .strict()
    .superRefine((v, ctx) => addIssues(schemaValidIssues(v), ctx)),
] as const;

/** Spec-load validation: one message per problem (empty = valid). */
export function structuredCheckParamIssues(
  name: StructuredCheckName,
  params: Record<string, unknown> | undefined,
): string[] {
  const parsed = STRUCTURED_CHECK_PARAM_SCHEMAS[name].safeParse(params ?? {});
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => {
    const at = i.path.length > 0 ? ` at params.${i.path.join(".")}` : "";
    return `${name}: ${i.message}${at}`;
  });
}

// ── Evaluation ────────────────────────────────────────────────────────────

/** One observed file: its path, its sha256, and its text when it was captured. */
export interface StructuredCheckFile {
  path: string;
  /** Lowercase hex, no prefix; null for a deleted file. */
  sha256: string | null;
  /** Present only when the file's text was captured. */
  content?: string;
}

/** What a structured check reads. Absent fields were not observed and fail closed. */
export interface StructuredCheckInput {
  /** Response text (skill eval) or stdout (command run). */
  text: string;
  /** Process exit code; undefined = no process, null = killed by a signal. */
  exit_code?: number | null;
  /** Observed files; undefined = this run observes no files. */
  files?: StructuredCheckFile[];
  /** Why `files` is undefined, for the failure message. */
  files_unavailable?: string;
  /** Why file content is absent, when `files` carry no `content`. */
  content_unavailable?: string;
}

export interface StructuredCheckResult {
  passed: boolean;
  message: string;
}

/**
 * Build the input for a skill-eval outcome. The text is the response text;
 * files come from the claude-code trajectory manifest with content from the
 * captured text artifacts. A truncated trajectory (stop other than
 * "completed") exposes no files, matching the trajectory checks' refusal.
 */
export function structuredInputFromOutput(output: ExecutionOutput): StructuredCheckInput {
  const t = output.trajectory;
  if (!t) {
    return {
      text: output.text ?? "",
      files_unavailable:
        "this execution provider records no produced files (run with --execution-provider claude-code)",
    };
  }
  if (t.stop !== "completed") {
    return {
      text: output.text ?? "",
      files_unavailable: `the run ended with stop "${t.stop}", so its file manifest is truncated`,
    };
  }
  const text = new Map(
    output.artifacts.filter((a) => a.type === "text").map((a) => [a.filename, a.content]),
  );
  return {
    text: output.text ?? "",
    files: t.files.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      ...(text.has(f.path) ? { content: text.get(f.path)! } : {}),
    })),
  };
}

function normalizeSha(v: string): string {
  return v.startsWith("sha256:") ? v.slice("sha256:".length) : v;
}

/** Read the JSON document a check targets: the text, or a produced text file. */
function readDocument(
  input: StructuredCheckInput,
  file: string | undefined,
): { ok: true; doc: unknown; label: string } | { ok: false; message: string } {
  let raw: string;
  let label: string;
  if (file === undefined) {
    raw = input.text;
    label = "the output";
  } else {
    if (!input.files) {
      return {
        ok: false,
        message: `cannot read "${file}": ${input.files_unavailable ?? "no files observed"}`,
      };
    }
    const f = input.files.find((x) => x.path === file && x.sha256 !== null);
    if (!f) return { ok: false, message: `no file "${file}" was observed after the run` };
    if (f.content === undefined) {
      return {
        ok: false,
        message: `the content of "${file}" was not captured${input.content_unavailable ? ` (${input.content_unavailable})` : " (binary or oversized file)"}`,
      };
    }
    raw = f.content;
    label = `"${file}"`;
  }
  try {
    return { ok: true, doc: JSON.parse(raw), label };
  } catch (err) {
    return {
      ok: false,
      message: `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function brief(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/**
 * Run a structured check. Params are re-parsed here (defense in depth for a
 * criterion that reached the engine without the spec schema); invalid params
 * and anything not observed fail closed.
 */
export function runStructuredCheck(
  name: StructuredCheckName,
  input: StructuredCheckInput,
  params: Record<string, unknown> | undefined,
): StructuredCheckResult {
  const issues = structuredCheckParamIssues(name, params);
  if (issues.length > 0) {
    return { passed: false, message: `Check "${name}" errored: ${issues.join("; ")}` };
  }

  switch (name) {
    case "exit_code": {
      const p = STRUCTURED_CHECK_PARAM_SCHEMAS.exit_code.parse(params);
      if (input.exit_code === undefined) {
        return { passed: false, message: "no process exit code was observed for this run" };
      }
      if (input.exit_code === null) {
        return {
          passed: false,
          message: "the process was killed by a signal and has no exit code",
        };
      }
      return {
        passed: input.exit_code === p.equals,
        message: `exit code ${input.exit_code}; required ${p.equals}`,
      };
    }
    case "json_path": {
      const p = STRUCTURED_CHECK_PARAM_SCHEMAS.json_path.parse(params);
      const read = readDocument(input, p.file);
      if (!read.ok) return { passed: false, message: read.message };
      const segments = parseJsonPath(p.path) as JsonPathSegment[];
      const hit = resolveJsonPath(read.doc, segments);
      if (p.exists !== undefined) {
        return {
          passed: hit.found === p.exists,
          message: `${p.path} ${hit.found ? "exists" : "does not exist"} in ${read.label}`,
        };
      }
      if (!hit.found)
        return { passed: false, message: `${p.path} does not exist in ${read.label}` };
      if (p.matches !== undefined) {
        const v = hit.value;
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
          return {
            passed: false,
            message: `${p.path} is ${v === null ? "null" : Array.isArray(v) ? "an array" : "an object"}; \`matches\` needs a string, number or boolean`,
          };
        }
        const ok = new RegExp(p.matches).test(String(v));
        return {
          passed: ok,
          message: `${p.path} = ${brief(v)} ${ok ? "matches" : "does not match"} /${p.matches}/`,
        };
      }
      const ok = jsonEquals(hit.value, p.equals);
      return {
        passed: ok,
        message: ok
          ? `${p.path} equals ${brief(p.equals)}`
          : `${p.path} = ${brief(hit.value)}; expected ${brief(p.equals)}`,
      };
    }
    case "file_sha256": {
      const p = STRUCTURED_CHECK_PARAM_SCHEMAS.file_sha256.parse(params);
      if (!input.files) {
        return {
          passed: false,
          message: `cannot check "${p.path}": ${input.files_unavailable ?? "no files observed"}`,
        };
      }
      const f = input.files.find((x) => x.path === p.path && x.sha256 !== null);
      if (!f) return { passed: false, message: `no file "${p.path}" was observed after the run` };
      const want = normalizeSha(p.sha256);
      const got = normalizeSha(f.sha256!);
      return {
        passed: got === want,
        message:
          got === want
            ? `sha256 of ${p.path} matches`
            : `sha256 of ${p.path} is ${got}; expected ${want}`,
      };
    }
    case "schema_valid": {
      const p = STRUCTURED_CHECK_PARAM_SCHEMAS.schema_valid.parse(params);
      const read = readDocument(input, p.file);
      if (!read.ok) return { passed: false, message: read.message };
      const validate = compileJsonSchema(p.schema) as ValidateFunction;
      if (validate(read.doc)) {
        return {
          passed: true,
          message: `${read.label} validates against the schema (draft 2020-12)`,
        };
      }
      const errs = (validate.errors ?? [])
        .slice(0, 3)
        .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
        .join("; ");
      return { passed: false, message: `${read.label} fails the schema: ${errs}` };
    }
  }
}
