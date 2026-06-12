/**
 * Kernel shadow-equivalence test (iaj-E02, v2.0.0 post-migration).
 *
 * Per DR-018 § 6.4 (Q2 Option α): j-rig now RE-EXPORTS the kernel's
 * `EvidenceStatementSchema` as its primary schema and RETAINS a secondary
 * `.superRefine` behavioral cross-field check for ONE MAJOR VERSION CYCLE.
 *
 * Post-migration, the j-rig `EvidenceStatementSchema` IS the kernel schema
 * (with an additional secondary check layered on top). This test proves:
 *
 *   D1. in-toto Statement v1 `_type` constant is identical in both.
 *   D2. predicate-URI constant is identical in both.
 *   D3. Both schemas reject the same malformed inputs (subject digest + name).
 *   D4. Cross-field invariant I1 (subject[0].name === predicate.gate_id) rejects
 *       in BOTH schemas on the same violation — the j-rig secondary check
 *       is belt-and-suspenders on top of the kernel's primary enforcement.
 *   D5. Cross-field invariant I2 (subject[0].digest.sha256 === predicate.input_hash
 *       sans `sha256:` prefix) rejects in BOTH on the same violation.
 *   D6. Both accept the canonical kernel-shaped statement (v2 gate-result/v1 body).
 *   D7. Both reject the v1-shaped statement (old result/timestamp body) — the
 *       predicate body migration is complete; v1 shape is no longer valid.
 *
 * Note on secondary check behavior: because j-rig's schema is the kernel schema
 * plus an additional superRefine, a statement that fails only j-rig's secondary
 * check would pass the kernel's primary schema. In practice, the secondary check
 * duplicates the kernel's invariants exactly, so any input that fails one fails
 * both. The kernel-shadow test proves this equivalence.
 */
import { describe, it, expect } from "vitest";

// j-rig's schema (kernel primary + j-rig secondary superRefine).
import {
  EvidenceStatementSchema as JRigStatementSchema,
  PREDICATE_URI as JRIG_PREDICATE_URI,
  STATEMENT_TYPE as JRIG_STATEMENT_TYPE,
} from "./evidence-bundle.js";

// The kernel-canonical schema (primary enforcement).
import {
  EvidenceStatementSchema as KernelStatementSchema,
  IN_TOTO_STATEMENT_V1_TYPE as KERNEL_STATEMENT_TYPE,
} from "@intentsolutions/core/validators/v1/evidence-statement";
import { GATE_RESULT_V1_URI as KERNEL_PREDICATE_URI } from "@intentsolutions/core/validators/v1/gate-result-v1";

// ── Shared structural fixtures ──────────────────────────────────────────────
const SHA = "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";
const GATE_ID = "j-rig:ci:coverage";
const INPUT_HASH = `sha256:${SHA}` as const;

/**
 * Valid v2 kernel statement (wraps the NORMATIVE gate-result/v1 body with
 * gate_decision, evaluated_at, and the new required fields).
 * This is the ONLY valid shape post-migration; both j-rig and kernel schemas
 * must accept it.
 */
function validStatement() {
  return {
    _type: KERNEL_STATEMENT_TYPE,
    subject: [{ name: GATE_ID, digest: { sha256: SHA } }],
    predicateType: KERNEL_PREDICATE_URI,
    predicate: {
      gate_id: GATE_ID,
      gate_name: "coverage",
      gate_version: "2.0.0",
      gate_decision: "pass" as const,
      gate_reasons: ["all criteria met"],
      coverage: { dimensions_evaluated: ["lines"], dimensions_skipped: [] },
      policy_ref: `sha256:${SHA}:vitest.config.ts`,
      policy_hash: `sha256:${SHA}`,
      input_hash: INPUT_HASH,
      evaluated_at: "2026-06-11T03:24:04Z",
      runner: "j-rig@2.0.0",
      commit_sha: "abc1234",
    },
  };
}

describe("kernel shadow-equivalence: in-toto wrapper constants (D1, D2)", () => {
  it("D1 — both implementations use the identical in-toto Statement v1 _type", () => {
    expect(JRIG_STATEMENT_TYPE).toBe(KERNEL_STATEMENT_TYPE);
    expect(JRIG_STATEMENT_TYPE).toBe("https://in-toto.io/Statement/v1");
  });

  it("D2 — both implementations use the identical immutable predicate URI", () => {
    expect(JRIG_PREDICATE_URI).toBe(KERNEL_PREDICATE_URI);
    expect(JRIG_PREDICATE_URI).toBe("https://evals.intentsolutions.io/gate-result/v1");
  });
});

describe("kernel shadow-equivalence: both accept the canonical v2 statement (D6)", () => {
  it("j-rig schema accepts the v2 kernel fixture", () => {
    expect(JRigStatementSchema.safeParse(validStatement()).success).toBe(true);
  });

  it("kernel schema accepts the v2 kernel fixture", () => {
    expect(KernelStatementSchema.safeParse(validStatement()).success).toBe(true);
  });
});

describe("kernel shadow-equivalence: both reject the v1-shaped statement (D7)", () => {
  it("both reject a predicate with old 'result' field instead of gate_decision", () => {
    const v1Stmt = {
      _type: KERNEL_STATEMENT_TYPE,
      subject: [{ name: GATE_ID, digest: { sha256: SHA } }],
      predicateType: KERNEL_PREDICATE_URI,
      predicate: {
        gate_id: GATE_ID,
        result: "PASS", // v1 field — not in v2 strict schema
        policy_hash: `sha256:${SHA}`,
        input_hash: INPUT_HASH,
        timestamp: "2026-06-11T03:24:04Z", // v1 field — replaced by evaluated_at
        runner: "j-rig@1.1.0",
        commit_sha: "abc1234",
      },
    };
    expect(JRigStatementSchema.safeParse(v1Stmt).success).toBe(false);
    expect(KernelStatementSchema.safeParse(v1Stmt).success).toBe(false);
  });
});

describe("kernel shadow-equivalence: subject digest + name validation (D3)", () => {
  it("both reject a malformed (uppercase) subject digest", () => {
    const jrig = validStatement();
    jrig.subject[0]!.digest.sha256 = SHA.toUpperCase();
    const kernel = validStatement();
    kernel.subject[0]!.digest.sha256 = SHA.toUpperCase();
    expect(JRigStatementSchema.safeParse(jrig).success).toBe(false);
    expect(KernelStatementSchema.safeParse(kernel).success).toBe(false);
  });

  it("both reject a subject name that violates the gate-id regex", () => {
    const badName = "J-RIG:ci:coverage"; // uppercase tool segment is invalid
    const jrig = validStatement();
    jrig.subject[0]!.name = badName;
    jrig.predicate.gate_id = badName;
    const kernel = validStatement();
    kernel.subject[0]!.name = badName;
    kernel.predicate.gate_id = badName;
    expect(JRigStatementSchema.safeParse(jrig).success).toBe(false);
    expect(KernelStatementSchema.safeParse(kernel).success).toBe(false);
  });
});

describe("kernel shadow-equivalence: cross-field invariant I1 (D4)", () => {
  it("both reject when subject[0].name !== predicate.gate_id", () => {
    const jrig = validStatement();
    jrig.subject[0]!.name = "j-rig:ci:other-gate";
    const kernel = validStatement();
    kernel.subject[0]!.name = "j-rig:ci:other-gate";
    expect(JRigStatementSchema.safeParse(jrig).success).toBe(false);
    expect(KernelStatementSchema.safeParse(kernel).success).toBe(false);
  });
});

describe("kernel shadow-equivalence: cross-field invariant I2 (D5)", () => {
  it("both reject when subject digest !== predicate.input_hash sans sha256: prefix", () => {
    const otherSha = "def1234567890abcdef1234567890abcdef1234567890abcdef1234567890def";
    const jrig = validStatement();
    jrig.subject[0]!.digest.sha256 = otherSha; // diverges from predicate.input_hash
    const kernel = validStatement();
    kernel.subject[0]!.digest.sha256 = otherSha;
    expect(JRigStatementSchema.safeParse(jrig).success).toBe(false);
    expect(KernelStatementSchema.safeParse(kernel).success).toBe(false);
  });
});
