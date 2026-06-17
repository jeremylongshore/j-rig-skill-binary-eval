/**
 * Shared op-parsing + bounds enforcement for RefinerStrategy implementations.
 *
 * Both reference strategies ask the model for a small JSON block describing
 * bounded edit ops, then parse + bound them here. Keeping this pure + shared
 * means the op grammar is validated identically across mechanisms, and it is
 * unit-testable without any model call.
 */

import { z } from "zod";
import type { EditOp } from "../types.js";

/** Maximum ops a single proposal may carry (bounded-edit discipline, AC per SkillOpt). */
export const MAX_OPS_PER_PROPOSAL = 8;

const addOpSchema = z.object({
  kind: z.literal("add"),
  after: z.string().min(1),
  content: z.string().min(1),
});
const deleteOpSchema = z.object({
  kind: z.literal("delete"),
  target: z.string().min(1),
});
const replaceOpSchema = z.object({
  kind: z.literal("replace"),
  target: z.string().min(1),
  content: z.string().min(1),
});

const opSchema = z.discriminatedUnion("kind", [addOpSchema, deleteOpSchema, replaceOpSchema]);

const responseSchema = z.object({
  rationale: z.string(),
  ops: z.array(opSchema),
});

export interface ParsedProposal {
  readonly rationale: string;
  readonly ops: readonly EditOp[];
}

export class OpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpParseError";
  }
}

/**
 * Extract the first balanced JSON object from a model completion. Models often
 * wrap JSON in prose or fences; we locate the first `{` and scan to its matching
 * `}` (respecting string literals + escapes).
 */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) throw new OpParseError("no JSON object found in completion");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new OpParseError("unterminated JSON object in completion");
}

/**
 * Parse + bound a model completion into a proposal. Enforces:
 *   - valid op grammar (add/delete/replace with non-empty anchors),
 *   - at most MAX_OPS_PER_PROPOSAL ops (excess is truncated, not an error,
 *     keeping the mechanism robust to over-eager models).
 *
 * @throws OpParseError if no parseable, schema-valid JSON is present.
 */
export function parseProposalResponse(completion: string): ParsedProposal {
  let json: string;
  try {
    json = extractJsonObject(completion);
  } catch (e) {
    throw e instanceof OpParseError ? e : new OpParseError(String(e));
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new OpParseError(`completion JSON did not parse: ${String(e)}`);
  }

  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OpParseError(`completion did not match op schema: ${parsed.error.message}`);
  }

  const ops = parsed.data.ops.slice(0, MAX_OPS_PER_PROPOSAL);
  return { rationale: parsed.data.rationale, ops };
}
