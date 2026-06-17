/**
 * applyEdit — pure transformation of a SkillDoc by a bounded EditProposal.
 *
 * Append-only discipline (AC-2): applyEdit NEVER mutates its input. It returns a
 * NEW SkillDoc value with a freshly-computed content hash. The proposal's
 * `parent` must match the input doc's hash, or the edit is refused (you cannot
 * apply an edit proposed against a different version).
 *
 * Each op is anchored to an EXACT substring (SkillOpt-style bounded edits). An op
 * whose anchor/target is not found, or is ambiguous (appears more than once),
 * fails loudly — silent partial application would corrupt the audit trail.
 */

import type { SkillDoc, EditProposal, EditOp } from "./types.js";
import { hashSkillDoc } from "./hash.js";

export class EditApplicationError extends Error {
  constructor(
    message: string,
    readonly op: EditOp,
  ) {
    super(message);
    this.name = "EditApplicationError";
  }
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function requireUnique(text: string, anchor: string, op: EditOp): void {
  if (anchor.length === 0) {
    throw new EditApplicationError("edit anchor/target is empty", op);
  }
  const occurrences = countOccurrences(text, anchor);
  if (occurrences === 0) {
    throw new EditApplicationError(
      `edit anchor/target not found in skill doc: ${JSON.stringify(anchor.slice(0, 60))}`,
      op,
    );
  }
  if (occurrences > 1) {
    throw new EditApplicationError(
      `edit anchor/target is ambiguous (${occurrences} occurrences): ${JSON.stringify(anchor.slice(0, 60))}`,
      op,
    );
  }
}

function applyOp(text: string, op: EditOp): string {
  switch (op.kind) {
    case "add": {
      requireUnique(text, op.after, op);
      const idx = text.indexOf(op.after) + op.after.length;
      return text.slice(0, idx) + op.content + text.slice(idx);
    }
    case "delete": {
      requireUnique(text, op.target, op);
      return text.replace(op.target, "");
    }
    case "replace": {
      requireUnique(text, op.target, op);
      return text.replace(op.target, op.content);
    }
  }
}

/**
 * Apply a bounded EditProposal to a SkillDoc, returning a new SkillDoc.
 *
 * @throws EditApplicationError if the proposal's parent does not match the doc,
 *         or any op's anchor is missing/ambiguous.
 */
export function applyEdit(doc: SkillDoc, proposal: EditProposal): SkillDoc {
  if (proposal.parent !== doc.hash) {
    throw new EditApplicationError(
      `proposal parent (${proposal.parent.slice(0, 8)}) does not match doc hash (${doc.hash.slice(0, 8)})`,
      proposal.ops[0] ?? { kind: "delete", target: "" },
    );
  }
  let text = doc.text;
  for (const op of proposal.ops) {
    text = applyOp(text, op);
  }
  return {
    skillId: doc.skillId,
    text,
    hash: hashSkillDoc(text),
  };
}

/** Convenience constructor: build a SkillDoc value from raw text. */
export function makeSkillDoc(skillId: string, text: string): SkillDoc {
  return { skillId, text, hash: hashSkillDoc(text) };
}
