import { describe, expect, it } from "vitest";
import { SkillEvalSpecSchema } from "@j-rig/core";
import {
  buildDraftPrompt,
  draftFunctionalItems,
  extractJsonObject,
  judgePromptProblem,
  MAX_DRAFT_CRITERIA,
  MAX_DRAFT_TEST_CASES,
  normalizeDraft,
  SpecDraftError,
  type DraftCompletionClient,
} from "./spec-draft.js";
import { applyDraft, buildBaselineSpec } from "../commands/scaffold-spec.js";

const OUT = "output-not-empty";
const RESERVED = new Set(["output-not-empty", "engages-with-stated-intent", "no-prompt-leakage"]);

const GOOD = {
  criteria: [
    {
      id: "Names Root Cause",
      description: "Names the likely root cause",
      blocker: true,
      judge_prompt: "Does the response name a specific likely root cause?",
    },
    {
      id: "gives-next-step",
      description: "Gives a concrete next step",
      judge_prompt: "Does the response give one concrete next step?",
    },
  ],
  test_cases: [
    {
      id: "oom-crash",
      description: "Typical crash report",
      tier: "core",
      prompt: "My job died with exit code 137 after an hour. What happened?",
      criteria_ids: ["names-root-cause", "gives-next-step"],
    },
    {
      id: "vague-report",
      description: "Report with missing detail",
      tier: "edge",
      prompt: "It broke again.",
      criteria_ids: ["gives-next-step"],
    },
  ],
};

function fakeClient(text: string): DraftCompletionClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (req) => {
      prompts.push(req.prompt);
      return text;
    },
  };
}

describe("spec-draft — extractJsonObject", () => {
  it("reads a fenced JSON block surrounded by prose", () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 });
  });

  it("reads bare JSON", () => {
    expect(extractJsonObject('{"criteria":[]}')).toEqual({ criteria: [] });
  });

  it("fails closed on a response with no JSON object", () => {
    expect(() => extractJsonObject("I cannot help with that.")).toThrow(SpecDraftError);
  });

  it("fails closed on malformed JSON", () => {
    expect(() => extractJsonObject("{criteria: [}")).toThrow(/did not parse/);
  });
});

describe("spec-draft — normalizeDraft", () => {
  it("keeps valid items, prefixes ids, forces judge method, and remaps references", () => {
    const d = normalizeDraft(GOOD, RESERVED, OUT);
    expect(d.criteria.map((c) => c.id)).toEqual(["fn-names-root-cause", "fn-gives-next-step"]);
    expect(d.criteria.every((c) => c.method === "judge")).toBe(true);
    expect(d.criteria[0]?.blocker).toBe(true);
    expect(d.criteria[1]?.blocker).toBe(false);
    expect(d.test_cases[0]).toMatchObject({
      id: "fn-oom-crash",
      tier: "core",
      criteria_ids: ["output-not-empty", "fn-names-root-cause", "fn-gives-next-step"],
    });
    expect(d.test_cases[0]).not.toHaveProperty("trigger_expectation");
    expect(d.dropped).toEqual([]);
  });

  it("drops a criterion with no judge_prompt and any case left with no criteria", () => {
    const d = normalizeDraft(
      {
        criteria: [{ id: "x", description: "no prompt" }],
        test_cases: [{ id: "t", description: "d", tier: "core", prompt: "p", criteria_ids: ["x"] }],
      },
      RESERVED,
      OUT,
    );
    expect(d.criteria).toEqual([]);
    expect(d.test_cases).toEqual([]);
    expect(d.dropped).toEqual([
      "criterion x: missing judge_prompt",
      "test case t: references no kept criterion",
    ]);
  });

  it("drops a criterion no kept test case grades", () => {
    const d = normalizeDraft(
      {
        criteria: [...GOOD.criteria, { id: "orphan", description: "o", judge_prompt: "o?" }],
        test_cases: GOOD.test_cases,
      },
      RESERVED,
      OUT,
    );
    expect(d.criteria.map((c) => c.id)).not.toContain("fn-orphan");
    expect(d.dropped).toContain("criterion fn-orphan: no kept test case grades it");
  });

  it("rejects reserved tiers, duplicate ids, and missing prompts", () => {
    const d = normalizeDraft(
      {
        criteria: [GOOD.criteria[1], GOOD.criteria[1]],
        test_cases: [
          {
            id: "a",
            description: "d",
            tier: "adversarial",
            prompt: "p",
            criteria_ids: ["gives-next-step"],
          },
          { id: "b", description: "d", tier: "core", criteria_ids: ["gives-next-step"] },
          {
            id: "c",
            description: "d",
            tier: "edge",
            prompt: "p",
            criteria_ids: ["gives-next-step"],
          },
          {
            id: "c",
            description: "d",
            tier: "edge",
            prompt: "p",
            criteria_ids: ["gives-next-step"],
          },
        ],
      },
      RESERVED,
      OUT,
    );
    expect(d.test_cases.map((t) => t.id)).toEqual(["fn-c"]);
    expect(d.dropped).toEqual([
      "criterion gives-next-step: duplicate id fn-gives-next-step",
      "test case a: tier must be core or edge",
      "test case b: prompt: Invalid input: expected string, received undefined",
      "test case c: duplicate id fn-c",
    ]);
  });

  it("never collides with a reserved baseline id", () => {
    const d = normalizeDraft(
      {
        criteria: [{ id: "fn-output-not-empty", description: "d", judge_prompt: "q?" }],
        test_cases: [],
      },
      new Set(["fn-output-not-empty"]),
      OUT,
    );
    expect(d.criteria).toEqual([]);
    expect(d.dropped[0]).toMatch(/duplicate id/);
  });

  it("caps the number of criteria", () => {
    const many = Array.from({ length: MAX_DRAFT_CRITERIA + 2 }, (_, i) => ({
      id: `c${i}`,
      description: "d",
      judge_prompt: "q?",
    }));
    const d = normalizeDraft(
      {
        criteria: many,
        test_cases: [
          {
            id: "t",
            description: "d",
            tier: "core",
            prompt: "p",
            criteria_ids: many.map((c) => c.id),
          },
        ],
      },
      RESERVED,
      OUT,
    );
    expect(d.criteria).toHaveLength(MAX_DRAFT_CRITERIA);
    expect(d.dropped.filter((x) => x.includes("cap"))).toHaveLength(2);
  });

  it("treats a non-object response as empty", () => {
    expect(normalizeDraft(null, RESERVED, OUT)).toEqual({
      criteria: [],
      test_cases: [],
      dropped: [],
    });
  });
});

describe("spec-draft — draftFunctionalItems", () => {
  it("sends the SKILL.md to the model and returns the normalized draft", async () => {
    const client = fakeClient("```json\n" + JSON.stringify(GOOD) + "\n```");
    const d = await draftFunctionalItems({
      client,
      model: "m",
      skillName: "crash-medic",
      skillMd: "# Crash medic\nDiagnose job crashes.",
      reservedIds: RESERVED,
      outputNotEmptyId: OUT,
    });
    expect(d.criteria).toHaveLength(2);
    expect(client.prompts[0]).toContain("Diagnose job crashes.");
    expect(client.prompts[0]).toContain('"crash-medic"');
  });

  it("fails closed when nothing usable survives", async () => {
    await expect(
      draftFunctionalItems({
        client: fakeClient('{"criteria":[{"id":"x"}],"test_cases":[]}'),
        model: "m",
        skillName: "s",
        skillMd: "x",
        reservedIds: RESERVED,
        outputNotEmptyId: OUT,
      }),
    ).rejects.toThrow(/no usable functional criteria: criterion x: missing judge_prompt/);
  });

  it("produces a spec J-Rig can load once merged onto the baseline", async () => {
    const spec = buildBaselineSpec("crash-medic", "Diagnose job crashes.");
    const d = await draftFunctionalItems({
      client: fakeClient(JSON.stringify(GOOD)),
      model: "m",
      skillName: "crash-medic",
      skillMd: "x",
      reservedIds: RESERVED,
      outputNotEmptyId: OUT,
    });
    applyDraft(spec, d);
    expect(spec.tags).toEqual(["generated", "draft", "needs-review"]);
    const parsed = SkillEvalSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(true);
  });
});

describe("spec-draft — buildDraftPrompt", () => {
  it("truncates a very long SKILL.md", () => {
    const prompt = buildDraftPrompt("s", "x".repeat(20_000));
    expect(prompt).toContain("[... truncated ...]");
    expect(prompt.length).toBeLessThan(15_000);
  });
});

describe("spec-draft — review hardening", () => {
  it("reads only the first balanced object when the response holds several", () => {
    expect(extractJsonObject('Here: {"a":{"b":"}"}} and also {"c":2}')).toEqual({ a: { b: "}" } });
  });

  it("fails closed on an unterminated object", () => {
    expect(() => extractJsonObject('{"a":1')).toThrow(/no JSON object/);
  });

  it("drops judge prompts that are not gradeable yes/no questions", () => {
    expect(judgePromptProblem("Does the response name the root cause?")).toBeNull();
    expect(judgePromptProblem("The response names the root cause.")).toMatch(/not a yes\/no/);
    expect(judgePromptProblem("On a scale of 1-5, how complete is it?")).toMatch(/rating/);
    expect(judgePromptProblem("Rate the answer. Is it good?")).toMatch(/rating/);
    expect(judgePromptProblem("Does it follow SKILL.md step 3?")).toMatch(/SKILL\.md/);

    const d = normalizeDraft(
      {
        criteria: [{ id: "scale", description: "d", judge_prompt: "Score it from 1 to 10?" }],
        test_cases: [],
      },
      RESERVED,
      OUT,
    );
    expect(d.dropped).toEqual([
      "criterion scale: judge_prompt asks for a rating, not a yes/no verdict",
    ]);
  });

  it("uses the caller's output-presence criterion id", () => {
    const d = normalizeDraft(GOOD, RESERVED, "custom-not-empty");
    expect(d.test_cases[0]?.criteria_ids).toEqual([
      "custom-not-empty",
      "fn-names-root-cause",
      "fn-gives-next-step",
    ]);
  });

  it("caps the number of test cases", () => {
    const cases = Array.from({ length: MAX_DRAFT_TEST_CASES + 3 }, (_, i) => ({
      id: `t${i}`,
      description: "d",
      tier: "core",
      prompt: "p",
      criteria_ids: ["gives-next-step"],
    }));
    const d = normalizeDraft({ criteria: [GOOD.criteria[1]], test_cases: cases }, RESERVED, OUT);
    expect(d.test_cases).toHaveLength(MAX_DRAFT_TEST_CASES);
    expect(d.dropped.filter((x) => x.includes("case cap"))).toHaveLength(3);
  });

  it("states the caps, the tiers, and the exact JSON shape in the prompt", () => {
    const prompt = buildDraftPrompt("s", "body");
    expect(prompt).toContain(
      `At most ${MAX_DRAFT_CRITERIA} criteria and ${MAX_DRAFT_TEST_CASES} test cases.`,
    );
    expect(prompt).toContain("tier 'core' for typical requests and 'edge' for hard ones");
    expect(prompt).toContain('{"criteria":[{"id":"kebab-id"');
    expect(prompt).toContain("ONE checkable binary claim");
  });
});
