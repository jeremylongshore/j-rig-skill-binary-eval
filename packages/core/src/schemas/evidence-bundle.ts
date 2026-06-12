/**
 * Evidence Bundle schemas — v2.0.0 kernel migration (DR-018, iaj-E02).
 *
 * Per ISEDC Session 5 Q2 Option α: the kernel `@intentsolutions/core` is now
 * the canonical schema authority. This file RE-EXPORTS the kernel's
 * `EvidenceStatementSchema` / `EvidenceBundlePayloadSchema` as j-rig's public
 * surface and RETAINS j-rig's original behavioral cross-field invariant checks
 * as a secondary `.superRefine` layered on top — one-cycle retention as
 * mandated by DR-018 § 6.3 ("belt-and-suspenders" guard, to be removed in v3).
 *
 * BREAKING changes from v1.x (v0.1.0-draft shape → kernel gate-result/v1):
 *   - `result` (PASS/FAIL/ADVISORY/NOT_APPLICABLE) → `gate_decision` (pass/fail/advisory/error)
 *   - `timestamp` → `evaluated_at` (same RFC 3339 format, now with offset)
 *   - NEW required: gate_name, gate_version, gate_reasons, coverage, policy_ref
 *   - NOT_APPLICABLE is no longer a gate_decision value; route via coverage.dimensions_skipped
 *   - `EvidenceBundleSchema` (json-array container) is superseded by kernel's
 *     `EvidenceBundlePayloadSchema` (plain array of EvidenceStatement rows).
 *     The legacy container form is kept as `LegacyBundleContainerSchema` for
 *     backward-compatible read paths in reader.ts.
 *
 * Backward-compatible export aliases:
 *   `EvidenceStatementSchema` → kernel's EvidenceStatementSchema (+ j-rig secondary check)
 *   `EvidenceBundleSchema`    → kernel's EvidenceBundlePayloadSchema (array form)
 *   `GateResultPredicateSchema` → kernel's GateResultV1Schema
 *   `PREDICATE_URI`           → kernel's GATE_RESULT_V1_URI (unchanged value)
 *   `STATEMENT_TYPE`          → kernel's IN_TOTO_STATEMENT_V1_TYPE (unchanged value)
 *   `GateResultEnum`          → kernel's GateDecisionSchema (now lowercase: pass/fail/advisory/error)
 *   `AdvisorySeverityEnum`    → kernel's AdvisorySeveritySchema
 */
import { z } from "zod";

// ── Kernel imports (primary schema authority) ──────────────────────────────
export {
  EvidenceStatementSchema as KernelEvidenceStatementSchema,
  EvidenceBundlePayloadSchema,
  IN_TOTO_STATEMENT_V1_TYPE,
  type EvidenceStatement as KernelEvidenceStatement,
  type EvidenceBundlePayload,
} from "@intentsolutions/core/validators/v1/evidence-statement";

export {
  GateResultV1Schema,
  GateDecisionSchema,
  AdvisorySeveritySchema,
  ReplayFidelityLevelSchema,
  SubjectSideSchema,
  GATE_RESULT_V1_URI,
  type GateResultV1,
} from "@intentsolutions/core/validators/v1/gate-result-v1";

// Re-export the kernel's subject primitive — SubjectSchema is a backward-compat
// alias so existing consumers keep working (P2 fix: remove local re-declaration).
export { InTotoSubjectSchema } from "@intentsolutions/core/validators/v1/evidence-bundle";

import {
  EvidenceStatementSchema as KernelEvidenceStatementSchemaInternal,
  EvidenceBundlePayloadSchema,
  IN_TOTO_STATEMENT_V1_TYPE,
} from "@intentsolutions/core/validators/v1/evidence-statement";
import {
  GateResultV1Schema,
  GateDecisionSchema,
  AdvisorySeveritySchema,
  GATE_RESULT_V1_URI,
} from "@intentsolutions/core/validators/v1/gate-result-v1";
import { InTotoSubjectSchema } from "@intentsolutions/core/validators/v1/evidence-bundle";

// ── Constants (values unchanged — backward-compatible aliases) ─────────────

/** Canonical predicate URI — unchanged from v1 (SPEC.md § R4). */
export const PREDICATE_URI = GATE_RESULT_V1_URI;

/** in-toto Statement v1 `_type` URI — unchanged from v1. */
export const STATEMENT_TYPE = IN_TOTO_STATEMENT_V1_TYPE;

// ── Enums (backward-compatible re-exports with v2 names) ──────────────────

/**
 * Gate decision enum — v2 uses lowercase values (`pass`, `fail`, `advisory`,
 * `error`). v1 used uppercase `PASS`, `FAIL`, `ADVISORY`, `NOT_APPLICABLE`.
 * `NOT_APPLICABLE` is no longer a decision value (DR-018 §279): use
 * `coverage.dimensions_skipped` instead.
 */
export const GateResultEnum = GateDecisionSchema;
export type GateResult = z.infer<typeof GateDecisionSchema>;

export const AdvisorySeverityEnum = AdvisorySeveritySchema;
export type AdvisorySeverity = z.infer<typeof AdvisorySeveritySchema>;

/** SPEC.md § 6 R8 — pipeline-hop side enum (retained from v1). */
export const PipelineSideEnum = z.enum(["client", "server", "ci", "sandbox", "local"]);
export type PipelineSide = z.infer<typeof PipelineSideEnum>;

// ── Regex constants (retained from v1 for direct-import consumers) ─────────

/** SPEC.md § R8 — gate_id regex (tool:side:gate-id). */
export const GATE_ID_REGEX =
  /^[a-z0-9][a-z0-9-]*:(client|server|ci|sandbox|local):[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

/** SPEC.md § R7 — sha256:<64-hex>. */
export const SHA256_PREFIXED_REGEX = /^sha256:[a-f0-9]{64}$/;

/** Runner identifier: tool@semver. */
export const RUNNER_REGEX =
  /^[a-z0-9][a-z0-9-]*@\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$/;

/** Git commit SHA: 7-40 hex chars. */
export const COMMIT_SHA_REGEX = /^[a-f0-9]{7,40}$/;

// ── Primary schemas (Option α: kernel is structural authority) ─────────────

/**
 * Predicate body for gate-result/v1. Now delegates to the kernel
 * `GateResultV1Schema` (the canonical normative contract per DR-018).
 *
 * Retained as `GateResultPredicateSchema` for backward-compatible import paths.
 */
export const GateResultPredicateSchema = GateResultV1Schema;
export type GateResultPredicate = z.infer<typeof GateResultV1Schema>;

/**
 * EvidenceStatement — kernel's canonical in-toto Statement v1 schema with the
 * Blueprint B § 7.3 cross-field invariants (I1 + I2) PLUS j-rig's secondary
 * behavioral cross-field check (Option α one-cycle retention per DR-018 § 6.3).
 *
 * The secondary check is a `.superRefine` layered on top of the kernel schema.
 * It MUST agree with the kernel invariants on every input; the kernel-shadow
 * test (`evidence-bundle.kernel-shadow.test.ts`) proves this equivalence.
 * Remove in v3.0.0 per DR-018 one-cycle retention rule.
 *
 * TODO(v3.0.0): remove backward-compat alias layer per DR-018 Option α one-cycle
 */
export const EvidenceStatementSchema = KernelEvidenceStatementSchemaInternal.superRefine(
  (stmt, ctx) => {
    // Secondary behavioral cross-field invariant check (j-rig Option α retention).
    // These mirror the kernel's I1 + I2 invariants exactly. Any disagreement
    // between this check and the kernel is a bug in this check.
    const subject0 = stmt.subject[0];
    /* v8 ignore next -- .min(1) guarantees subject[0]; guard is for noUncheckedIndexedAccess */
    if (subject0 === undefined) return;

    // I1 — subject[0].name MUST equal predicate.gate_id
    if (subject0.name !== stmt.predicate.gate_id) {
      ctx.addIssue({
        code: "custom",
        path: ["subject", 0, "name"],
        message:
          "j-rig secondary check I1: subject[0].name must equal predicate.gate_id",
      });
    }

    // I2 — subject[0].digest.sha256 MUST equal predicate.input_hash without sha256: prefix
    // No truthiness pre-check: the schema guarantees a 64-hex digest when
    // parsing succeeds; if the digest were ever absent the invariant must
    // FAIL rather than be silently skipped (fail-open) [f-jrig-core-5].
    const SHA256_PREFIX_LEN = "sha256:".length;
    if (subject0.digest.sha256 !== stmt.predicate.input_hash.slice(SHA256_PREFIX_LEN)) {
      ctx.addIssue({
        code: "custom",
        path: ["subject", 0, "digest", "sha256"],
        message:
          "j-rig secondary check I2: subject[0].digest.sha256 must equal predicate.input_hash without sha256: prefix",
      });
    }
  },
);

export type EvidenceStatement = z.infer<typeof EvidenceStatementSchema>;

/**
 * Subject shape — backward-compatible alias for the kernel's `InTotoSubjectSchema`.
 * The kernel's SubjectNameSchema uses the same gate_id regex and Sha256Schema
 * enforces the same 64-hex-char constraint, so this alias is structurally
 * equivalent to the previous hand-rolled local declaration (P2 fix: no more
 * local re-declaration of kernel primitives).
 *
 * GATE_ID_REGEX and the subject-digest regex `/^[a-f0-9]{64}$/` are now derived
 * from the kernel primitive rather than hand-rolled copies.
 */
// TODO(v3.0.0): remove backward-compat alias layer per DR-018 Option α one-cycle
export const SubjectSchema = InTotoSubjectSchema;
export type Subject = z.infer<typeof InTotoSubjectSchema>;

/**
 * EvidenceBundleSchema — backward-compatible alias for the kernel's
 * `EvidenceBundlePayloadSchema` (an array of EvidenceStatement rows).
 *
 * NOTE: the v1 container form `{ bundle_format: "json-array", rows: [...] }`
 * is available as `LegacyBundleContainerSchema` for reader backward-compat.
 * The primary wire format in v2 is a plain JSON array (EvidenceBundlePayload).
 */
export const EvidenceBundleSchema = EvidenceBundlePayloadSchema;
export type EvidenceBundle = z.infer<typeof EvidenceBundlePayloadSchema>;

/**
 * Legacy v1 bundle container form `{ bundle_format: "json-array", rows: [...] }`.
 * Preserved for backward-compatible read paths (reader.ts can still parse old
 * files written by v1). NOT recommended for new emit paths — use plain array.
 */
export const LegacyBundleContainerSchema = z
  .object({
    bundle_format: z.literal("json-array"),
    rows: z.array(EvidenceStatementSchema),
  })
  .strict();
export type LegacyBundleContainer = z.infer<typeof LegacyBundleContainerSchema>;
