/**
 * Kernel shadow-equivalence test (iaj-E02, SAFE first slice).
 *
 * Per DR-018 § 6.4 (Q2 Option α-minus): the kernel @intentsolutions/core folded
 * j-rig's `EvidenceStatement` row shape + the Blueprint B § 7.3 cross-field
 * invariants. j-rig re-exports the kernel shape AND "RETAINS its existing
 * behavioral secondary check for ONE MAJOR VERSION CYCLE" — a belt-and-suspenders
 * guard that the kernel's structural enforcement agrees with j-rig's local one.
 *
 * This test IS that belt-and-suspenders proof. It pins the two implementations
 * against each other on their GENUINELY-OVERLAPPING surface — the in-toto
 * Statement v1 WRAPPER + the two cross-field invariants — and asserts they
 * accept / reject equivalently.
 *
 * Scope discipline (why this is the safe slice, not the full v2.0.0 migration):
 * the kernel's `gate-result/v1` PREDICATE BODY (`GateResultV1Schema`) is the NEW
 * normative shape (`gate_decision`, `evaluated_at`, +5 required fields), while
 * j-rig at v1.x still emits the v0.1.0-draft predicate body (`result`,
 * `timestamp`). Migrating the predicate body is the breaking `@j-rig/*` v2.0.0
 * single-coherent-PR work (DR-018 § 6.3) and is deliberately NOT done here. What
 * IS proven here is that the wrapper + invariant logic the two share is
 * behaviorally identical — so the kernel can be trusted as the structural
 * authority while j-rig's local copy stays as the secondary check for one cycle.
 *
 * Equivalence dimensions proven:
 *   D1. in-toto Statement v1 `_type` constant is identical.
 *   D2. predicate-URI constant is identical.
 *   D3. subject-name regex + bare-sha256 digest validation agree on the same
 *       inputs (accept the well-formed, reject the malformed).
 *   D4. cross-field invariant I1 (subject[0].name === predicate.gate_id) rejects
 *       in BOTH implementations on the same violation.
 *   D5. cross-field invariant I2 (subject[0].digest.sha256 === predicate.input_hash
 *       sans `sha256:` prefix) rejects in BOTH implementations on the same
 *       violation.
 */
import { describe, it, expect } from "vitest";

// j-rig's hand-rolled local copy (the secondary check).
import {
  EvidenceStatementSchema as JRigStatementSchema,
  PREDICATE_URI as JRIG_PREDICATE_URI,
  STATEMENT_TYPE as JRIG_STATEMENT_TYPE,
} from "./evidence-bundle.js";

// The kernel-canonical fold (the structural authority).
import {
  EvidenceStatementSchema as KernelStatementSchema,
  IN_TOTO_STATEMENT_V1_TYPE as KERNEL_STATEMENT_TYPE,
} from "@intentsolutions/core/validators/v1/evidence-statement";
import { GATE_RESULT_V1_URI as KERNEL_PREDICATE_URI } from "@intentsolutions/core/validators/v1/gate-result-v1";

// ── Shared structural fixtures ──────────────────────────────────────────────
const SHA = "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";
const GATE_ID = "j-rig:ci:coverage";
const INPUT_HASH = `sha256:${SHA}` as const;

/** A valid j-rig statement (wraps the v0.1.0-draft `result`/`timestamp` body). */
function jrigStatement() {
  return {
    _type: JRIG_STATEMENT_TYPE,
    subject: [{ name: GATE_ID, digest: { sha256: SHA } }],
    predicateType: JRIG_PREDICATE_URI,
    predicate: {
      gate_id: GATE_ID,
      result: "PASS" as const,
      policy_hash: `sha256:${SHA}`,
      input_hash: INPUT_HASH,
      timestamp: "2026-06-11T03:24:04Z",
      runner: "j-rig@1.1.0",
      commit_sha: "abc1234",
    },
  };
}

/** A valid kernel statement (wraps the NORMATIVE `gate_decision`/`evaluated_at` body). */
function kernelStatement() {
  return {
    _type: KERNEL_STATEMENT_TYPE,
    subject: [{ name: GATE_ID, digest: { sha256: SHA } }],
    predicateType: KERNEL_PREDICATE_URI,
    predicate: {
      gate_id: GATE_ID,
      gate_name: "coverage",
      gate_version: "1.0.0",
      gate_decision: "pass" as const,
      gate_reasons: [],
      coverage: { dimensions_evaluated: ["lines"], dimensions_skipped: [] },
      policy_ref: `sha256:${SHA}:vitest.config.ts`,
      policy_hash: `sha256:${SHA}`,
      input_hash: INPUT_HASH,
      evaluated_at: "2026-06-11T03:24:04Z",
      runner: "j-rig@1.1.0",
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

describe("kernel shadow-equivalence: both accept their own valid statement", () => {
  it("j-rig schema accepts the j-rig fixture", () => {
    expect(JRigStatementSchema.safeParse(jrigStatement()).success).toBe(true);
  });

  it("kernel schema accepts the kernel fixture", () => {
    expect(KernelStatementSchema.safeParse(kernelStatement()).success).toBe(true);
  });
});

describe("kernel shadow-equivalence: subject digest + name validation (D3)", () => {
  it("both reject a malformed (uppercase) subject digest", () => {
    const jrig = jrigStatement();
    jrig.subject[0]!.digest.sha256 = SHA.toUpperCase();
    const kernel = kernelStatement();
    kernel.subject[0]!.digest.sha256 = SHA.toUpperCase();
    expect(JRigStatementSchema.safeParse(jrig).success).toBe(false);
    expect(KernelStatementSchema.safeParse(kernel).success).toBe(false);
  });

  it("both reject a subject name that violates the gate-id regex", () => {
    // Uppercase tool segment is invalid under both regexes; keep the
    // predicate.gate_id in lockstep so I1 is satisfied and the regex is the
    // sole reason for rejection.
    const badName = "J-RIG:ci:coverage";
    const jrig = jrigStatement();
    jrig.subject[0]!.name = badName;
    jrig.predicate.gate_id = badName;
    const kernel = kernelStatement();
    kernel.subject[0]!.name = badName;
    kernel.predicate.gate_id = badName;
    expect(JRigStatementSchema.safeParse(jrig).success).toBe(false);
    expect(KernelStatementSchema.safeParse(kernel).success).toBe(false);
  });
});

describe("kernel shadow-equivalence: cross-field invariant I1 (D4)", () => {
  it("both reject when subject[0].name !== predicate.gate_id", () => {
    const jrig = jrigStatement();
    jrig.subject[0]!.name = "j-rig:ci:other-gate";
    const kernel = kernelStatement();
    kernel.subject[0]!.name = "j-rig:ci:other-gate";
    expect(JRigStatementSchema.safeParse(jrig).success).toBe(false);
    expect(KernelStatementSchema.safeParse(kernel).success).toBe(false);
  });
});

describe("kernel shadow-equivalence: cross-field invariant I2 (D5)", () => {
  it("both reject when subject digest !== predicate.input_hash sans sha256: prefix", () => {
    const otherSha = "def1234567890abcdef1234567890abcdef1234567890abcdef1234567890def";
    const jrig = jrigStatement();
    jrig.subject[0]!.digest.sha256 = otherSha; // diverges from predicate.input_hash
    const kernel = kernelStatement();
    kernel.subject[0]!.digest.sha256 = otherSha;
    expect(JRigStatementSchema.safeParse(jrig).success).toBe(false);
    expect(KernelStatementSchema.safeParse(kernel).success).toBe(false);
  });
});
