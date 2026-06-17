/**
 * Content addressing for refiner value objects.
 *
 * Deterministic SHA-256 over canonical-JSON / UTF-8 text. Uses the Node
 * `node:crypto` builtin — no external dependency, no I/O. The same input always
 * yields the same hash, which is the basis for the append-only content-addressed
 * store (AC-2) and for comparing whether two ScoreRecords refer to the same skill.
 */

import { createHash } from "node:crypto";

/** Lowercase-hex SHA-256 of a UTF-8 string. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical JSON: object keys sorted recursively so structurally-equal values
 * hash identically regardless of key insertion order. Arrays preserve order
 * (order is meaningful for edit ops + eval items).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Content address of a SKILL.md document (hash of its text). */
export function hashSkillDoc(text: string): string {
  return sha256(text);
}

/** Content address of an arbitrary value object via canonical JSON. */
export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}
