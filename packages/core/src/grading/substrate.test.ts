import { describe, expect, it } from "vitest";
import {
  evaluateWithGrader,
  evaluateWithModelJudge,
  GraderDefinitionSchema,
  hashGraderSnapshot,
  type DeterministicGraderDefinition,
  type ModelJudgeGraderDefinition,
} from "./substrate.js";

const grader = GraderDefinitionSchema.parse({
  id: "answer-checker",
  version: "1.0.0",
  kind: "deterministic",
  checks: [
    { id: "has-answer", type: "output_contains", expected: "4" },
    { id: "has-explanation", type: "output_contains", expected: "because" },
  ],
}) as DeterministicGraderDefinition;

describe("named deterministic graders", () => {
  it("evaluates raw output without changing the source Run", () => {
    const grade = evaluateWithGrader("raw_123", "The answer is 4 because arithmetic.", grader);

    expect(grade.raw_run_id).toBe("raw_123");
    expect(grade.grader_id).toBe("answer-checker");
    expect(grade.grader_version).toBe("1.0.0");
    expect(grade.verdict).toBe("pass");
    expect(grade.score).toBe(1);
    expect(grade.checks).toHaveLength(2);
    expect(grade.grader_snapshot_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("keeps partial quality distinct from a required verdict", () => {
    const grade = evaluateWithGrader("raw_123", "The answer is 4.", grader);

    expect(grade.verdict).toBe("fail");
    expect(grade.score).toBe(0.5);
    expect(grade.checks[1]?.details).toContain("missing");
  });

  it("changes the snapshot hash when a grader version or rule changes", () => {
    const changed = GraderDefinitionSchema.parse({
      ...grader,
      version: "2.0.0",
      checks: [...grader.checks, { id: "has-period", type: "output_contains", expected: "." }],
    }) as DeterministicGraderDefinition;

    expect(hashGraderSnapshot(changed)).not.toBe(hashGraderSnapshot(grader));
  });
});

describe("model-judge graders", () => {
  it("retains sampled votes and disagreement while failing unsure closed", async () => {
    const definition = GraderDefinitionSchema.parse({
      id: "quality-judge",
      version: "1.0.0",
      kind: "model_judge",
      model: "fixture-judge",
      criterion_description: "The answer is correct",
      judge_prompt: "Answer yes only when the output is correct.",
      samples: 3,
    }) as ModelJudgeGraderDefinition;
    const votes: Array<"yes" | "no" | "unsure"> = ["yes", "no", "yes"];
    const judge = {
      async judge() {
        return {
          verdict: votes.shift() ?? "unsure",
          confidence: 0.5,
          reasoning: "fixture vote",
        };
      },
    };

    const grade = await evaluateWithModelJudge("raw_123", "The answer is 4.", definition, judge);

    expect(grade.verdict).toBe("pass");
    expect(grade.score).toBe(1);
    expect(grade.grader_kind).toBe("model_judge");
    expect(grade.metadata?.judge).toMatchObject({
      judge_model: "fixture-judge",
      raw_verdict: "yes",
      samples: 3,
      agreement: 2 / 3,
      sample_verdicts: ["yes", "no", "yes"],
      disagreement: true,
    });
  });

  it("maps a judge tie to a fail-closed Grade and preserves unsure evidence", async () => {
    const definition = GraderDefinitionSchema.parse({
      id: "tie-judge",
      version: "1.0.0",
      kind: "model_judge",
      model: "fixture-judge",
      criterion_description: "The output is acceptable",
      judge_prompt: "Answer yes or no.",
      samples: 2,
    }) as ModelJudgeGraderDefinition;
    let calls = 0;
    const alternatingJudge = {
      async judge() {
        calls++;
        return {
          verdict: calls === 1 ? ("yes" as const) : ("no" as const),
          confidence: 1,
          reasoning: "alternating fixture",
        };
      },
    };
    const grade = await evaluateWithModelJudge(
      "raw_tie",
      "ambiguous output",
      definition,
      alternatingJudge,
    );

    expect(grade.verdict).toBe("fail");
    expect(grade.metadata?.judge?.raw_verdict).toBe("unsure");
    expect(grade.metadata?.judge?.disagreement).toBe(true);
    expect(grade.metadata?.judge?.sample_verdicts).toEqual(["yes", "no"]);
  });
});
