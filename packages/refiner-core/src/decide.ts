/**
 * 4-quadrant decision matrix for the Skill Refiner accept gate (bead iev7).
 *
 * The two axes are:
 *   (1) schema-validity  — does the applied SKILL.md satisfy the kernel
 *                          authoring/v1 SkillFrontmatterSchema (IS 8-field tier)?
 *   (2) judge verdict    — does the proposed edit pass the existing accept()
 *                          gate (DR-028 P0-RATIFY-1 Pareto-dominant behavioral)?
 *
 * Matrix:
 *   ┌──────────────────────┬────────────────────────────────────────────────────┐
 *   │                      │  judge-improved (accept() returns accepted:true)   │
 *   │                      │        YES                  NO                    │
 *   ├──────────────────────┼────────────────────────────────────────────────────┤
 *   │ schema VALID         │  ACCEPT          │  REJECT                        │
 *   │ schema INVALID       │  LOG_TO_SCHEMA_  │  REJECT                        │
 *   │                      │  REVISION_CANDS  │                                │
 *   └──────────────────────┴────────────────────────────────────────────────────┘
 *
 * The LOG_TO_SCHEMA_REVISION_CANDIDATES quadrant is the novel contribution of
 * this bead: when the judge says the edit found a real behavioral improvement but
 * the resulting SKILL.md violates the current schema, that is a SIGNAL — the
 * current schema may be too restrictive and needs to evolve. We do NOT silently
 * drop the proposal; we surface it as a schema-revision candidate so it can feed
 * a reconciliation queue downstream.
 *
 * Relationship to the existing `accept()`:
 *   `decide()` COMPOSES on top of `accept()`. It does NOT replace it.
 *   `accept()` implements the judge-verdict axis (DR-028 P0-RATIFY-1). The
 *   schema-validity axis is layered ON TOP. The strictness of the judge
 *   predicate is unchanged.
 *
 * This function is PURE: given its inputs it always returns the same result.
 * No I/O. No side effects. No mutation.
 */

import { accept } from "./accept.js";
import type { ScoreRecord, EditProposal, RejectionReason } from "./types.js";
import { DEFAULT_ALPHA } from "./types.js";
import type { SchemaValidator, SchemaValidityResult } from "./schema-validator.js";

// ── Outcome types ──────────────────────────────────────────────────────────

/**
 * The proposal was accepted: schema is valid AND the judge confirmed
 * a strict behavioral improvement (DR-028 P0-RATIFY-1) with no regressions.
 */
export interface AcceptDecision {
  readonly outcome: "ACCEPT";
}

/**
 * The proposal was rejected. Either the schema is valid but the judge did not
 * confirm improvement, or both schema and judge verdict are unfavorable.
 * `judgeReason` is the machine-readable rejection reason from `accept()`.
 */
export interface RejectDecision {
  readonly outcome: "REJECT";
  /**
   * The reason `accept()` returned rejected.  Carried here so callers can
   * route to the existing rejected-edit buffer with the full audit context.
   */
  readonly judgeReason: RejectionReason;
  /**
   * Schema issues, if the applied SKILL.md was also schema-invalid.
   * Present only when the schema was invalid AND the judge also rejected.
   * When the schema was valid this field is omitted.
   */
  readonly schemaIssues?: readonly string[];
}

/**
 * The proposal found a behavioral improvement but the resulting SKILL.md
 * violates the current schema. This is a SIGNAL that the schema may need to
 * evolve — not a silent drop.
 *
 * The `candidate` field carries everything needed to feed a schema-revision
 * queue: the proposal that produced the improvement, the schema issues that
 * prevented acceptance, and the judge outcome confirming behavioral gain.
 */
export interface LogToSchemaRevisionCandidatesDecision {
  readonly outcome: "LOG_TO_SCHEMA_REVISION_CANDIDATES";
  readonly candidate: SchemaRevisionCandidate;
}

/** Discriminated union of all four quadrant outcomes. */
export type DecideOutcome = AcceptDecision | RejectDecision | LogToSchemaRevisionCandidatesDecision;

/**
 * A proposal that produced a behavioral improvement but whose resulting
 * SKILL.md violates the current schema. Fed to a schema-revision queue
 * downstream so the schema can be updated to accommodate proven improvements.
 *
 * Carries all provenance required for downstream reconciliation:
 *   - the proposal (parent hash, ops, strategy, model, rationale)
 *   - why the schema rejected it
 *   - the score records (baseline vs candidate) so the improvement is auditable
 */
export interface SchemaRevisionCandidate {
  /** The edit proposal that produced a behavioral improvement. */
  readonly proposal: EditProposal;
  /**
   * The schema-validity issues on the applied SKILL.md.
   * These are the kernel's `SkillFrontmatterSchema` validation errors that
   * blocked full acceptance — the issues a schema revision would need to
   * accommodate.
   */
  readonly schemaIssues: readonly string[];
  /** The baseline ScoreRecord (v1). */
  readonly baseline: ScoreRecord;
  /** The candidate ScoreRecord (v2, the one that improved behavioral). */
  readonly candidate: ScoreRecord;
  /**
   * The schema-validity result for the applied SKILL.md.
   * Always `{ valid: false, issues: [...] }` in a schema-revision candidate.
   */
  readonly schemaResult: SchemaValidityResult & { valid: false };
}

// ── Inputs ─────────────────────────────────────────────────────────────────

/**
 * Inputs to `decide()`.
 *
 * @field proposal       — the proposed edit (provenance: strategy, model, ops)
 * @field appliedDocText — the FULL text of the SKILL.md AFTER applying the
 *                         proposal (frontmatter + body). Schema-validity is
 *                         checked against this text.
 * @field baseline       — ScoreRecord of the current-best skill version (v1).
 * @field candidate      — ScoreRecord of the proposed skill version (v2).
 * @field validator      — injectable SchemaValidator. Pass
 *                         `kernelSkillFrontmatterValidator()` in production;
 *                         pass a stub in tests.
 * @field alpha          — significance level for the judge gate (default 0.05).
 */
export interface DecideInputs {
  readonly proposal: EditProposal;
  readonly appliedDocText: string;
  readonly baseline: ScoreRecord;
  readonly candidate: ScoreRecord;
  readonly validator: SchemaValidator;
  readonly alpha?: number;
}

// ── Core function ──────────────────────────────────────────────────────────

/**
 * 4-quadrant decision matrix: schema-validity × judge-verdict.
 *
 * Composes `accept()` (the judge-verdict axis) with a `SchemaValidator` (the
 * schema-validity axis) to produce a `DecideOutcome`. Does NOT replace or
 * weaken `accept()` — when schema and judge both pass, the result is the same
 * ACCEPT the pure `accept()` would produce.
 *
 * @param inputs — see {@link DecideInputs}
 */
export function decide(inputs: DecideInputs): DecideOutcome {
  const { proposal, appliedDocText, baseline, candidate, validator } = inputs;
  const alpha = inputs.alpha ?? DEFAULT_ALPHA;

  // Axis 1: judge verdict (DR-028 P0-RATIFY-1 Pareto-dominant behavioral).
  // We keep the raw AcceptResult so the TypeScript discriminated union stays
  // intact — extracting a boolean loses the `reason` narrowing.
  const judgeResult = accept(baseline, candidate, alpha);

  // Axis 2: schema-validity of the applied SKILL.md.
  const schemaResult = validator.validate(appliedDocText);

  // Quadrant 1: schema-valid AND judge-improved → ACCEPT
  if (schemaResult.valid && judgeResult.accepted) {
    return { outcome: "ACCEPT" };
  }

  // Quadrant 2: schema-valid AND judge-regression → REJECT
  // judgeResult.accepted is false here so .reason is always present.
  if (schemaResult.valid && !judgeResult.accepted) {
    return {
      outcome: "REJECT",
      judgeReason: judgeResult.reason,
    };
  }

  // Quadrant 3: schema-INVALID AND judge-improved → LOG_TO_SCHEMA_REVISION_CANDIDATES
  // schemaResult.valid is false here (TypeScript narrows to { valid: false; issues: string[] }).
  if (!schemaResult.valid && judgeResult.accepted) {
    return {
      outcome: "LOG_TO_SCHEMA_REVISION_CANDIDATES",
      candidate: {
        proposal,
        schemaIssues: schemaResult.issues,
        baseline,
        candidate,
        schemaResult,
      },
    };
  }

  // Quadrant 4: schema-INVALID AND judge-regression (both-invalid) → REJECT
  // Both !schemaResult.valid and !judgeResult.accepted are true here.
  // TypeScript narrows schemaResult to { valid: false; issues: string[] }
  // and judgeResult to { accepted: false; reason: RejectionReason }.
  if (!schemaResult.valid && !judgeResult.accepted) {
    return {
      outcome: "REJECT",
      judgeReason: judgeResult.reason,
      schemaIssues: schemaResult.issues,
    };
  }

  // Exhaustive guard — the four quadrants above are complete (2×2 boolean matrix).
  // This branch is unreachable but TypeScript requires a return for non-void functions.
  /* istanbul ignore next */
  throw new Error("decide(): unreachable — all four quadrants are covered");
}
