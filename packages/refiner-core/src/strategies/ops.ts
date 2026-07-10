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

/** Lenient outer envelope: a `{ rationale, ops[] }` object, ops validated per-item below. */
const responseEnvelopeSchema = z.object({
  rationale: z.string().default(""),
  ops: z.array(z.unknown()).default([]),
});

/**
 * Parse + bound a model completion into a proposal. Enforces:
 *   - a `{ rationale, ops[] }` envelope (the only hard requirement),
 *   - valid op grammar (add/delete/replace with non-empty anchors) PER OP —
 *     a malformed op is DROPPED, not fatal, so one bad op never discards a
 *     proposal's valid edits (robust to over-eager / imperfect models, esp.
 *     non-Anthropic ones that occasionally emit a field-incomplete op),
 *   - at most MAX_OPS_PER_PROPOSAL ops (excess truncated, not an error).
 *
 * Zero surviving valid ops is a valid outcome (an empty, no-op proposal), NOT
 * an error — mirrors a strategy that legitimately proposes nothing this pass.
 *
 * @throws OpParseError only if no JSON object is present, the JSON does not
 *   parse, or the envelope is not a `{ rationale, ops[] }` shape.
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

  const envelope = responseEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new OpParseError(
      `completion is not a { rationale, ops[] } object: ${envelope.error.message}`,
    );
  }

  const ops: EditOp[] = [];
  for (const candidate of envelope.data.ops) {
    if (ops.length >= MAX_OPS_PER_PROPOSAL) break; // bounded-edit discipline
    const op = opSchema.safeParse(candidate);
    if (op.success) ops.push(op.data); // drop malformed ops, keep the valid ones
  }
  return { rationale: envelope.data.rationale, ops };
}
