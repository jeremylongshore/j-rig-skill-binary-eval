/**
 * Tests for decide() — the 4-quadrant schema-validity × judge-verdict matrix.
 *
 * All four quadrants are exercised. The judge verdict is stubbed via ScoreRecord
 * values that produce known accept() outcomes (no mocking of accept() itself —
 * the unit under test is decide(), and accept() is a real collaborator). The
 * schema validator is stubbed via the injectable SchemaValidator interface.
 *
 * Regression discipline: the existing accept() semantics (DR-028 P0-RATIFY-1)
 * are preserved — tests in this file that pass schema-valid inputs produce the
 * same judge-path behavior as the accept.test.ts suite. We do not duplicate
 * every accept() case here; we exercise the schema-validity layer and its
 * interaction with the judge axis.
 */

import { describe, it, expect } from "vitest";
import { decide } from "./decide.js";
import type {
  DecideOutcome,
  SchemaRevisionCandidate,
  AcceptDecision,
  RejectDecision,
  LogToSchemaRevisionCandidatesDecision,
} from "./decide.js";
import type { SchemaValidator } from "./schema-validator.js";
import type { ScoreRecord, ScoreDimension, EditProposal } from "./types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const EVAL = "e".repeat(64);
const SKILL_V1 = "1".repeat(64);
const SKILL_V2 = "2".repeat(64);

function det(value: number): ScoreDimension {
  return { value, variance: 0, n: 1 };
}

function record(skill: string, dims: Record<string, ScoreDimension>, evalSet = EVAL): ScoreRecord {
  return {
    skill,
    evalSet,
    behavioral: dims.behavioral,
    dimensions: dims,
  };
}

/** Baseline: behavioral=0.7 (deterministic). Used in all judge-verdict stubs. */
const BASELINE = record(SKILL_V1, { behavioral: det(0.7), readability: det(0.9) });
/** Candidate that IMPROVES behavioral (accept() will return accepted:true). */
const CANDIDATE_IMPROVED = record(SKILL_V2, {
  behavioral: det(0.85),
  readability: det(0.9),
});
/** Candidate that does NOT improve behavioral (accept() returns rejected). */
const CANDIDATE_NO_IMPROVEMENT = record(SKILL_V2, {
  behavioral: det(0.7),
  readability: det(0.9),
});

/** A minimal valid EditProposal fixture. */
const PROPOSAL: EditProposal = {
  parent: SKILL_V1,
  ops: [{ kind: "replace", target: "old text", content: "new text" }],
  refinerModel: "claude-sonnet",
  refinerStrategyId: "naive-in-context-v1",
  rationale: "Improved clarity of trigger description.",
};

/** Minimal SKILL.md text — content doesn't matter for stub tests. */
const APPLIED_DOC_TEXT = `---
name: my-skill
description: A skill that does things.
---
Skill body.
`;

// ── Stub helpers ──────────────────────────────────────────────────────────

/** A SchemaValidator stub that always returns schema-valid. */
function validatorAlwaysValid(): SchemaValidator {
  return {
    validate: () => ({ valid: true }),
  };
}

/** A SchemaValidator stub that always returns schema-invalid with given issues. */
function validatorAlwaysInvalid(
  issues: string[] = ["missing required field: author"],
): SchemaValidator {
  return {
    validate: () => ({ valid: false, issues }),
  };
}

// ── Helper to assert discriminated union variants ─────────────────────────

function asAccept(result: DecideOutcome): AcceptDecision {
  if (result.outcome !== "ACCEPT") throw new Error(`Expected ACCEPT, got ${result.outcome}`);
  return result;
}
function asReject(result: DecideOutcome): RejectDecision {
  if (result.outcome !== "REJECT") throw new Error(`Expected REJECT, got ${result.outcome}`);
  return result;
}
function asLog(result: DecideOutcome): LogToSchemaRevisionCandidatesDecision {
  if (result.outcome !== "LOG_TO_SCHEMA_REVISION_CANDIDATES") {
    throw new Error(`Expected LOG_TO_SCHEMA_REVISION_CANDIDATES, got ${result.outcome}`);
  }
  return result;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("decide() — 4-quadrant schema-validity × judge-verdict matrix", () => {
  // ── Quadrant 1: schema-valid + judge-improved → ACCEPT ──────────────────

  describe("Quadrant 1 — schema-valid + judge-improved → ACCEPT", () => {
    it("returns ACCEPT when schema is valid AND judge confirms behavioral improvement", () => {
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_IMPROVED,
        validator: validatorAlwaysValid(),
      });

      const decision = asAccept(result);
      expect(decision.outcome).toBe("ACCEPT");
    });

    it("ACCEPT result carries no extra fields (pure discriminant)", () => {
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_IMPROVED,
        validator: validatorAlwaysValid(),
      });

      expect(result).toEqual({ outcome: "ACCEPT" });
    });

    it("ACCEPT is insensitive to the content of the doc text — schema stub controls validity", () => {
      // Even with garbage doc text, if the stub says valid + judge passes, it's ACCEPT.
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: "not even yaml",
        baseline: BASELINE,
        candidate: CANDIDATE_IMPROVED,
        validator: validatorAlwaysValid(),
      });

      expect(result).toEqual({ outcome: "ACCEPT" });
    });
  });

  // ── Quadrant 2: schema-valid + judge-regression → REJECT ────────────────

  describe("Quadrant 2 — schema-valid + judge-regression → REJECT", () => {
    it("returns REJECT when schema is valid BUT judge finds no behavioral improvement", () => {
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_NO_IMPROVEMENT,
        validator: validatorAlwaysValid(),
      });

      const decision = asReject(result);
      expect(decision.outcome).toBe("REJECT");
      expect(decision.judgeReason).toBe("no-behavioral-improvement");
    });

    it("REJECT carries the judge reason for the existing audit buffer", () => {
      // Behavioral REGRESSES
      const candidateRegressed = record(SKILL_V2, {
        behavioral: det(0.5),
        readability: det(0.9),
      });

      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: candidateRegressed,
        validator: validatorAlwaysValid(),
      });

      const decision = asReject(result);
      expect(decision.judgeReason).toBe("no-behavioral-improvement");
      expect(decision.schemaIssues).toBeUndefined();
    });

    it("REJECT with pareto-incomparable judge reason when behavioral improves but a dim regresses", () => {
      const candidatePareto = record(SKILL_V2, {
        behavioral: det(0.9),
        readability: det(0.4), // significant regression
      });

      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: candidatePareto,
        validator: validatorAlwaysValid(),
      });

      const decision = asReject(result);
      expect(decision.judgeReason).toBe("pareto-incomparable");
    });

    it("REJECT carries no schemaIssues when schema was valid", () => {
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_NO_IMPROVEMENT,
        validator: validatorAlwaysValid(),
      });

      const decision = asReject(result);
      expect(decision.schemaIssues).toBeUndefined();
    });
  });

  // ── Quadrant 3: schema-INVALID + judge-improved → LOG_TO_SCHEMA_REVISION_CANDIDATES

  describe("Quadrant 3 — schema-INVALID + judge-improved → LOG_TO_SCHEMA_REVISION_CANDIDATES", () => {
    it("returns LOG_TO_SCHEMA_REVISION_CANDIDATES when schema is invalid AND judge confirms improvement", () => {
      const schemaIssues = ["author: Required", "version: Required"];
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_IMPROVED,
        validator: validatorAlwaysInvalid(schemaIssues),
      });

      const decision = asLog(result);
      expect(decision.outcome).toBe("LOG_TO_SCHEMA_REVISION_CANDIDATES");
    });

    it("LOG candidate carries the proposal verbatim", () => {
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_IMPROVED,
        validator: validatorAlwaysInvalid(),
      });

      const decision = asLog(result);
      const cand: SchemaRevisionCandidate = decision.candidate;
      expect(cand.proposal).toBe(PROPOSAL);
    });

    it("LOG candidate carries the schema issues that blocked acceptance", () => {
      const schemaIssues = ["missing required field: author", "version must be semver"];
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_IMPROVED,
        validator: validatorAlwaysInvalid(schemaIssues),
      });

      const decision = asLog(result);
      expect(decision.candidate.schemaIssues).toEqual(schemaIssues);
    });

    it("LOG candidate carries baseline and candidate ScoreRecords for downstream audit", () => {
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_IMPROVED,
        validator: validatorAlwaysInvalid(),
      });

      const decision = asLog(result);
      expect(decision.candidate.baseline).toBe(BASELINE);
      expect(decision.candidate.candidate).toBe(CANDIDATE_IMPROVED);
    });

    it("LOG candidate schemaResult is always valid:false with matching issues", () => {
      const schemaIssues = ["name: must match kebab-case pattern"];
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_IMPROVED,
        validator: validatorAlwaysInvalid(schemaIssues),
      });

      const decision = asLog(result);
      expect(decision.candidate.schemaResult.valid).toBe(false);
      if (!decision.candidate.schemaResult.valid) {
        expect(decision.candidate.schemaResult.issues).toEqual(schemaIssues);
      }
    });

    it("LOG is NOT produced when schema is invalid but judge also rejects (→ REJECT instead)", () => {
      // This guards the quadrant boundary: invalid schema + no behavioral improvement = REJECT
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_NO_IMPROVEMENT,
        validator: validatorAlwaysInvalid(),
      });

      expect(result.outcome).toBe("REJECT");
    });
  });

  // ── Quadrant 4: schema-INVALID + judge-regression → REJECT (both-invalid)

  describe("Quadrant 4 — schema-INVALID + judge-regression → REJECT", () => {
    it("returns REJECT when BOTH schema is invalid AND judge finds no improvement", () => {
      const schemaIssues = ["missing required field: license"];
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_NO_IMPROVEMENT,
        validator: validatorAlwaysInvalid(schemaIssues),
      });

      const decision = asReject(result);
      expect(decision.outcome).toBe("REJECT");
    });

    it("both-invalid REJECT carries judgeReason AND schemaIssues", () => {
      const schemaIssues = ["author: Required", "tags must be an array"];
      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: CANDIDATE_NO_IMPROVEMENT,
        validator: validatorAlwaysInvalid(schemaIssues),
      });

      const decision = asReject(result);
      expect(decision.judgeReason).toBe("no-behavioral-improvement");
      expect(decision.schemaIssues).toEqual(schemaIssues);
    });

    it("both-invalid REJECT with pareto-incomparable judge reason", () => {
      // Behavioral improves but readability regresses → judge: pareto-incomparable
      // AND schema is invalid → Quadrant 4 (schema-invalid, judge-rejection)
      const candidatePareto = record(SKILL_V2, {
        behavioral: det(0.9),
        readability: det(0.4),
      });

      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: BASELINE,
        candidate: candidatePareto,
        validator: validatorAlwaysInvalid(["missing: author"]),
      });

      // pareto-incomparable means accept() returns rejected (no-pareto-dominance)
      // → judge-regression quadrant (not judge-improved)
      const decision = asReject(result);
      expect(decision.judgeReason).toBe("pareto-incomparable");
      expect(decision.schemaIssues).toEqual(["missing: author"]);
    });
  });

  // ── Cross-cutting: incomparable-records propagates correctly ────────────

  describe("incomparable-records judge rejection propagates through the matrix", () => {
    it("different eval sets → REJECT with incomparable-records (schema-valid path)", () => {
      const baselineDiffEval = record(SKILL_V1, { behavioral: det(0.7) }, "e".repeat(64));
      const candidateDiffEval = record(SKILL_V2, { behavioral: det(0.9) }, "f".repeat(64));

      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: baselineDiffEval,
        candidate: candidateDiffEval,
        validator: validatorAlwaysValid(),
      });

      const decision = asReject(result);
      expect(decision.judgeReason).toBe("incomparable-records");
    });

    it("different eval sets + invalid schema → REJECT with incomparable-records + schemaIssues", () => {
      const baselineDiffEval = record(SKILL_V1, { behavioral: det(0.7) }, "e".repeat(64));
      const candidateDiffEval = record(SKILL_V2, { behavioral: det(0.9) }, "f".repeat(64));
      const issues = ["author: Required"];

      const result = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: baselineDiffEval,
        candidate: candidateDiffEval,
        validator: validatorAlwaysInvalid(issues),
      });

      const decision = asReject(result);
      expect(decision.judgeReason).toBe("incomparable-records");
      expect(decision.schemaIssues).toEqual(issues);
    });
  });

  // ── Custom alpha is forwarded to the judge ───────────────────────────────

  describe("custom alpha forwarded to accept()", () => {
    it("stricter alpha can flip a judge-improved case to judge-rejected", () => {
      // SE = sqrt(0.04/30 + 0.04/30) ≈ 0.0516; delta = 0.10 → z ≈ 1.94
      // significant at α=0.05 (z* 1.645) but NOT at α=0.001 (z* ≈ 3.09)
      const baselineNoisy = record(SKILL_V1, {
        behavioral: { value: 0.5, variance: 0.04, n: 30 },
      });
      const candidateNoisy = record(SKILL_V2, {
        behavioral: { value: 0.6, variance: 0.04, n: 30 },
      });

      const lenient = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: baselineNoisy,
        candidate: candidateNoisy,
        validator: validatorAlwaysValid(),
        alpha: 0.05,
      });
      const strict = decide({
        proposal: PROPOSAL,
        appliedDocText: APPLIED_DOC_TEXT,
        baseline: baselineNoisy,
        candidate: candidateNoisy,
        validator: validatorAlwaysValid(),
        alpha: 0.001,
      });

      expect(lenient.outcome).toBe("ACCEPT");
      expect(strict.outcome).toBe("REJECT");
    });
  });
});

// ── SchemaValidator — extractFrontmatter + parseFrontmatterYaml unit tests ─

import { extractFrontmatter, parseFrontmatterYaml } from "./schema-validator.js";

describe("extractFrontmatter()", () => {
  it("extracts the YAML block from a well-formed SKILL.md", () => {
    const text = `---
name: my-skill
description: Does things.
---
Body.`;
    expect(extractFrontmatter(text)).toBe("name: my-skill\ndescription: Does things.");
  });

  it("returns null when the text does not start with ---", () => {
    expect(extractFrontmatter("# Heading\nno frontmatter")).toBeNull();
  });

  it("returns null when there is no closing --- delimiter", () => {
    expect(extractFrontmatter("---\nname: x\n")).toBeNull();
  });

  it("handles closing ... delimiter", () => {
    const text = "---\nname: x\n...\nBody.";
    expect(extractFrontmatter(text)).toBe("name: x");
  });

  it("strips a BOM from the beginning", () => {
    const text = "﻿---\nname: x\n---\nBody.";
    expect(extractFrontmatter(text)).toBe("name: x");
  });
});

describe("parseFrontmatterYaml()", () => {
  it("parses scalar key-value pairs", () => {
    const yaml = "name: my-skill\ndescription: Does things.";
    expect(parseFrontmatterYaml(yaml)).toEqual({
      name: "my-skill",
      description: "Does things.",
    });
  });

  it("parses an inline flow list", () => {
    const yaml = "allowed-tools: [Read, Edit, Bash]";
    expect(parseFrontmatterYaml(yaml)).toEqual({
      "allowed-tools": ["Read", "Edit", "Bash"],
    });
  });

  it("parses a block sequence (- item lines)", () => {
    const yaml = "tags:\n  - typescript\n  - refiner";
    expect(parseFrontmatterYaml(yaml)).toEqual({
      tags: ["typescript", "refiner"],
    });
  });

  it("strips single and double quotes from scalars", () => {
    const yaml = "author: 'Intent Solutions'\nlicense: \"Apache-2.0\"";
    expect(parseFrontmatterYaml(yaml)).toEqual({
      author: "Intent Solutions",
      license: "Apache-2.0",
    });
  });

  it("returns an empty object for empty YAML", () => {
    expect(parseFrontmatterYaml("")).toEqual({});
    expect(parseFrontmatterYaml("   ")).toEqual({});
  });

  it("skips comment lines", () => {
    const yaml = "# This is a comment\nname: x";
    expect(parseFrontmatterYaml(yaml)).toEqual({ name: "x" });
  });
});

// ── kernelSkillFrontmatterValidator integration tests ──────────────────────
//
// These tests use the REAL kernel validator (not a stub). They verify that the
// concrete implementation correctly validates against the IS 8-field
// marketplace tier.

import { kernelSkillFrontmatterValidator } from "./schema-validator.js";

const VALID_SKILL_DOC = `---
name: my-skill
description: Does something useful for evaluating skills.
allowed-tools: Read
version: 1.0.0
author: Intent Solutions
license: Apache-2.0
compatibility: Claude Code >=1.0.0
tags:
  - eval
  - refiner
---
Skill body.
`;

describe("kernelSkillFrontmatterValidator() — concrete kernel integration", () => {
  it("returns valid:true for a well-formed IS 8-field SKILL.md", () => {
    const validator = kernelSkillFrontmatterValidator();
    const result = validator.validate(VALID_SKILL_DOC);
    expect(result.valid).toBe(true);
  });

  it("returns valid:false for a SKILL.md missing required IS overlay fields", () => {
    const missingFields = `---
name: my-skill
description: Does something.
---
Body.
`;
    const validator = kernelSkillFrontmatterValidator();
    const result = validator.validate(missingFields);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("returns valid:false and surfaces issues when there is no frontmatter block", () => {
    const noFrontmatter = "# My Skill\nJust a markdown file.";
    const validator = kernelSkillFrontmatterValidator();
    const result = validator.validate(noFrontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues[0]).toMatch(/frontmatter|YAML|---/i);
    }
  });

  it("returns valid:false when the name field violates the kebab-case pattern", () => {
    const badName = `---
name: My Skill With Spaces
description: Does something useful.
allowed-tools: Read
version: 1.0.0
author: Intent Solutions
license: Apache-2.0
compatibility: Claude Code >=1.0.0
tags:
  - eval
---
Body.
`;
    const validator = kernelSkillFrontmatterValidator();
    const result = validator.validate(badName);
    expect(result.valid).toBe(false);
  });
});
