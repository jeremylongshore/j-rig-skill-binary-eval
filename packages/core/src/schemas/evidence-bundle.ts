/**
 * Evidence Bundle schemas — Zod mirrors of the v0.1.0-draft spec at
 * https://github.com/jeremylongshore/intent-eval-lab/blob/main/specs/evidence-bundle/v0.1.0-draft/SPEC.md
 *
 * Source-of-truth JSON Schema is at
 *   intent-eval-lab/specs/evidence-bundle/v0.1.0-draft/schema/gate-result.schema.json
 *
 * This file MUST stay in lock-step with that schema. Any divergence is a bug
 * in this file (the lab spec wins). The conformance test in
 *   evidence-bundle.test.ts
 * validates this Zod schema against the same example fixtures the lab spec uses.
 */
import { z } from "zod";

/** SPEC.md § R4 — the predicate URI is immutable. */
export const PREDICATE_URI = "https://evals.intentsolutions.io/gate-result/v1" as const;

/** SPEC.md § 4 R1 — in-toto Statement v1 _type. */
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;

/** SPEC.md § 5 R6 — closed enum. */
export const GateResultEnum = z.enum(["PASS", "FAIL", "ADVISORY", "NOT_APPLICABLE"]);
export type GateResult = z.infer<typeof GateResultEnum>;

export const AdvisorySeverityEnum = z.enum(["info", "warn", "error"]);
export type AdvisorySeverity = z.infer<typeof AdvisorySeverityEnum>;

/** SPEC.md § 6 R8 — pipeline-hop side enum. */
export const PipelineSideEnum = z.enum(["client", "server", "ci", "sandbox", "local"]);
export type PipelineSide = z.infer<typeof PipelineSideEnum>;

/**
 * SPEC.md § R8 — gate_id regex.
 * `tool:side:gate-id` where tool is lowercase kebab-case, side is the closed
 * enum above, and gate-id permits mixed case (MM-1..MM-6, etc.).
 */
export const GATE_ID_REGEX =
  /^[a-z0-9][a-z0-9-]*:(client|server|ci|sandbox|local):[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

/** SPEC.md § R7 — sha256:<64-hex>. */
export const SHA256_PREFIXED_REGEX = /^sha256:[a-f0-9]{64}$/;

/** Runner identifier: tool@semver. */
export const RUNNER_REGEX =
  /^[a-z0-9][a-z0-9-]*@\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$/;

/** Git commit SHA: 7-40 hex chars. */
export const COMMIT_SHA_REGEX = /^[a-f0-9]{7,40}$/;

/**
 * Predicate body for the gate-result/v1 predicate. Mirrors
 * gate-result.schema.json field-for-field.
 */
export const GateResultPredicateSchema = z
  .object({
    gate_id: z
      .string()
      .regex(GATE_ID_REGEX, "gate_id must match tool:side:gate-id (SPEC § R8)"),
    result: GateResultEnum,
    policy_hash: z.string().regex(SHA256_PREFIXED_REGEX, "policy_hash must be sha256:<64-hex>"),
    input_hash: z.string().regex(SHA256_PREFIXED_REGEX, "input_hash must be sha256:<64-hex>"),
    timestamp: z
      .string()
      .datetime({ message: "timestamp must be a valid RFC 3339 UTC string" }),
    runner: z.string().regex(RUNNER_REGEX, "runner must be tool@semver"),
    commit_sha: z.string().regex(COMMIT_SHA_REGEX, "commit_sha must be 7-40 hex chars"),
    metadata: z.record(z.string(), z.unknown()).optional(),
    failure_mode: z.string().optional(),
    advisory_severity: AdvisorySeverityEnum.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // SPEC § R6: ADVISORY result requires advisory_severity (mirrors JSON Schema allOf/if).
    if (data.result === "ADVISORY" && !data.advisory_severity) {
      ctx.addIssue({
        code: "custom",
        path: ["advisory_severity"],
        message: "advisory_severity is required when result is ADVISORY (SPEC § R6)",
      });
    }
  });

export type GateResultPredicate = z.infer<typeof GateResultPredicateSchema>;

/** SPEC.md § 6 R8-R9 — subject naming + digest invariants. */
export const SubjectSchema = z.object({
  name: z.string().regex(GATE_ID_REGEX, "subject.name must match the gate_id regex (SPEC § R8)"),
  digest: z
    .object({
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/, "subject.digest.sha256 must be 64 hex chars (no prefix)"),
    })
    .strict(),
});
export type Subject = z.infer<typeof SubjectSchema>;

/**
 * Full in-toto Statement v1 carrying a gate-result/v1 predicate.
 *
 * Cross-field invariants (SPEC § R9):
 *   - subject[0].name === predicate.gate_id
 *   - 'sha256:' + subject[0].digest.sha256 === predicate.input_hash
 */
export const EvidenceStatementSchema = z
  .object({
    _type: z.literal(STATEMENT_TYPE),
    subject: z.array(SubjectSchema).min(1),
    predicateType: z.literal(PREDICATE_URI),
    predicate: GateResultPredicateSchema,
  })
  .strict()
  .superRefine((stmt, ctx) => {
    const subjectName = stmt.subject[0]?.name;
    const subjectDigest = stmt.subject[0]?.digest.sha256;
    if (subjectName !== stmt.predicate.gate_id) {
      ctx.addIssue({
        code: "custom",
        path: ["subject", 0, "name"],
        message: `subject[0].name (${subjectName}) must equal predicate.gate_id (${stmt.predicate.gate_id}) per SPEC § R8`,
      });
    }
    if (subjectDigest && `sha256:${subjectDigest}` !== stmt.predicate.input_hash) {
      ctx.addIssue({
        code: "custom",
        path: ["subject", 0, "digest", "sha256"],
        message: `subject[0].digest.sha256 must equal predicate.input_hash without the sha256: prefix (SPEC § R9)`,
      });
    }
  });

export type EvidenceStatement = z.infer<typeof EvidenceStatementSchema>;

/**
 * SPEC.md § R1 — bundle is a collection of zero-or-more Statements.
 * The "json-array" container form documented in the SPEC is what we model
 * here; JSONL and one-file-per-row forms compose the same row schema.
 */
export const EvidenceBundleSchema = z
  .object({
    bundle_format: z.literal("json-array"),
    rows: z.array(EvidenceStatementSchema),
  })
  .strict();
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
