/**
 * EvalSet schema, validation, and eval_set_ref derivation.
 *
 * An EvalSet is the frozen, signed set of eval cases a refiner verdict is
 * derived against — it is the ENTIRE epistemic basis of a
 * `skill-refiner-pass/v1` claim. Its identity and versioning must therefore
 * be exact and tamper-evident.
 *
 * This module ships:
 *   1. A Zod schema (`EvalSetSchema`) that validates an `EvalSet` value,
 *      including UUIDv7 shape for `lineageId`, sha256-prefixed format for
 *      `hash`, and ISO-8601 for `refreshDueAt`.
 *   2. `deriveEvalSetRef()` — projects an `EvalSet` into the `EvalSetRef`
 *      shape the `skill-refiner-pass/v1` predicate's `eval_set_ref` field
 *      consumes (`{ hash, version, lineage_id }`), with `hash` sha256-prefixed.
 *   3. `isRefreshDue()` — returns `true` when the eval set's `refreshDueAt`
 *      timestamp is in the past (or null with `treatNullAsDue` option), which
 *      signals that the eval set must be re-reviewed before another refiner
 *      verdict can be trusted.
 *   4. `validateEvalSet()` — parse-and-validate helper that throws a
 *      `ZodError` (with path-annotated field errors) on malformed input.
 *
 * Sources:
 *   - intent-eval-lab/000-docs/083-AT-SPEC-skill-refiner-pass-v1-normative-spec-2026-06-17.md § 5.1
 *   - DR-028 P0-RATIFY-6
 *   - @intentsolutions/core UUIDV7_PATTERN / SHA256_PREFIXED_PATTERN (mirrored here
 *     without taking a dep on the kernel, per the pure-core / no-external-dep rule)
 */

import { z } from "zod";
import type { EvalSet, EvalSetRef } from "./types.js";

// ─── Format patterns (mirrored from @intentsolutions/core/primitives.ts) ─────
//
// We do NOT depend on @intentsolutions/core here — refiner-core is a pure
// value-oriented library with no external deps beyond `zod`. These patterns
// are EXACT copies of the kernel's UUIDV7_PATTERN / SHA256_PREFIXED_PATTERN
// (RFC 9562 UUIDv7; Blueprint B § 7.4 sha256-prefixed). If the kernel pattern
// changes, update here in lockstep (the comment references are the audit trail).

/**
 * RFC 9562 UUIDv7 recognition pattern: version nibble `7`, variant `10xx`,
 * lowercase hex. Mirrors `@intentsolutions/core/src/primitives.ts` UUIDV7_PATTERN.
 */
export const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Bare 64-lowercase-hex SHA-256 pattern (the hash stored on an EvalSet's `hash`
 * field — un-prefixed, because EvalSet.hash is the content address used for
 * lineage comparison, not the on-wire predicate hash).
 */
export const SHA256_REGEX = /^[0-9a-f]{64}$/;

/**
 * Prefixed `sha256:<64-lowercase-hex>` pattern used by `EvalSetRef.hash`
 * (the predicate field). Mirrors `@intentsolutions/core/src/primitives.ts`
 * SHA256_PREFIXED_PATTERN (Blueprint B § 7.4).
 */
export const SHA256_PREFIXED_REGEX = /^sha256:[0-9a-f]{64}$/;

// ─── Zod sub-schemas ──────────────────────────────────────────────────────────

/** Bare 64-hex SHA-256 (EvalSet.hash / EvalSet.lineageParent). */
const sha256Z = z
  .string()
  .regex(SHA256_REGEX, "must be 64 lowercase hex characters (bare SHA-256)");

/** UUIDv7 string (EvalSet.lineageId). */
const uuidv7Z = z
  .string()
  .regex(
    UUIDV7_REGEX,
    "must be a valid UUIDv7 (RFC 9562: version nibble 7, variant 10xx, lowercase hex)",
  );

/** Non-empty version string. */
const versionZ = z.string().min(1, "version must be a non-empty string (e.g. '1.0.0')");

/** ISO-8601 / rfc3339 timestamp — validated by parsing with Date. */
const rfc3339Z = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "must be a valid ISO-8601 / rfc3339 timestamp",
});

/** EvalItem schema. */
export const EvalItemSchema = z.object({
  id: z.string().min(1, "id must be non-empty"),
  prompt: z.string().min(1, "prompt must be non-empty"),
  expectation: z.string().optional(),
});

/** EvalSetSource enum. */
export const EvalSetSourceSchema = z.enum(["synthetic", "harvested", "golden", "hybrid"]);

/**
 * Zod schema for an {@link EvalSet}.
 *
 * Validates:
 * - `hash`           — bare 64-hex SHA-256 (content address).
 * - `skillId`        — non-empty string.
 * - `source`         — closed `EvalSetSource` enum.
 * - `items`          — non-empty array of `EvalItem`.
 * - `evalSetVersion` — non-empty string (e.g. semver).
 * - `lineageParent`  — bare 64-hex SHA-256, or `null` for root sets.
 * - `refreshDueAt`   — valid ISO-8601 timestamp, or `null` (quick mode).
 * - `lineageId`      — UUIDv7 string (lineage identity for the predicate's
 *                      `eval_set_ref.lineage_id`).
 */
export const EvalSetSchema: z.ZodType<EvalSet> = z.object({
  hash: sha256Z,
  skillId: z.string().min(1, "skillId must be non-empty"),
  source: EvalSetSourceSchema,
  items: z.array(EvalItemSchema).min(1, "items must not be empty"),
  evalSetVersion: versionZ,
  lineageParent: z.union([sha256Z, z.null()]),
  refreshDueAt: z.union([rfc3339Z, z.null()]),
  lineageId: uuidv7Z,
});

/**
 * Parse and validate an `EvalSet` value. Throws a `ZodError` with
 * path-annotated messages on any field violation.
 *
 * @throws {z.ZodError} on validation failure.
 */
export function validateEvalSet(value: unknown): EvalSet {
  return EvalSetSchema.parse(value);
}

// ─── EvalSetRef derivation ───────────────────────────────────────────────────

/**
 * Derive the `EvalSetRef` the `skill-refiner-pass/v1` predicate's
 * `eval_set_ref` field consumes from a (validated) `EvalSet`.
 *
 * The mapping is:
 * - `hash`       ← `"sha256:" + evalSet.hash`  (adds the prefix; the
 *                  predicate spec § 5.4 requires `sha256:<64-hex>`).
 * - `version`    ← `evalSet.evalSetVersion`
 * - `lineage_id` ← `evalSet.lineageId`
 *
 * The function is deterministic: calling it twice on the same `EvalSet`
 * always produces the identical `EvalSetRef` object.
 *
 * @throws {z.ZodError} if `evalSet` does not satisfy the schema (i.e. you
 *   passed an unvalidated value). Validate first with `validateEvalSet()` if
 *   the source is untrusted.
 */
export function deriveEvalSetRef(evalSet: EvalSet): EvalSetRef {
  // Validate the input — if the caller passes a malformed EvalSet, fail loud.
  EvalSetSchema.parse(evalSet);

  return {
    hash: `sha256:${evalSet.hash}`,
    version: evalSet.evalSetVersion,
    lineage_id: evalSet.lineageId,
  };
}

// ─── Refresh-due detection ───────────────────────────────────────────────────

export interface IsRefreshDueOptions {
  /**
   * Wall-clock "now" as an rfc3339 string. Injected for determinism (tests
   * pass a known timestamp instead of reading the real clock).
   * Defaults to `new Date().toISOString()` when omitted.
   */
  readonly now?: string;
  /**
   * When `true`, a `null` `refreshDueAt` (quick-mode sets) is treated as
   * "due immediately" — useful for conservative callers that want to require
   * an explicit refresh-due date before accepting a verdict over the set.
   * Defaults to `false`.
   */
  readonly treatNullAsDue?: boolean;
}

/**
 * Returns `true` when the eval set's `refreshDueAt` timestamp is in the past
 * (or NOW), signalling that the set must be re-reviewed before a new refiner
 * verdict can be trusted.
 *
 * A stale eval set undermines the `skill-refiner-pass/v1` claim: the
 * predicate's "frozen eval-set" contract requires the set was current when
 * the verdict was emitted. Callers SHOULD surface a "refresh due" warning (or
 * block signing) when this returns `true`.
 *
 * `null` `refreshDueAt` (quick-mode): treated as NOT due by default, because
 * quick-mode contributors intentionally skipped the refresh budget. Pass
 * `treatNullAsDue: true` to enforce a strict posture instead.
 */
export function isRefreshDue(evalSet: EvalSet, opts: IsRefreshDueOptions = {}): boolean {
  const { refreshDueAt } = evalSet;

  if (refreshDueAt === null) {
    return opts.treatNullAsDue === true;
  }

  const nowMs = opts.now !== undefined ? Date.parse(opts.now) : Date.now();
  const dueMs = Date.parse(refreshDueAt);
  return nowMs >= dueMs;
}

// ─── EvalSetRef Zod schema (for downstream validators) ───────────────────────

/**
 * Zod schema for the `EvalSetRef` shape consumed by the `skill-refiner-pass/v1`
 * predicate's `eval_set_ref` field (DR-082 § 5.1).
 *
 * `additionalProperties: false` semantics: the Zod `.strict()` call rejects
 * unknown keys, exactly matching the JSON Schema constraint on the predicate.
 */
export const EvalSetRefSchema: z.ZodType<EvalSetRef> = z
  .object({
    hash: z
      .string()
      .regex(
        SHA256_PREFIXED_REGEX,
        "must be sha256-prefixed: 'sha256:' followed by 64 lowercase hex chars",
      ),
    version: versionZ,
    lineage_id: uuidv7Z,
  })
  .strict();
