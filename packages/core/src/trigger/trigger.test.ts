import { describe, it, expect } from "vitest";
import { buildRoster, formatRoster } from "./roster.js";
import { runTriggerTests } from "./runner.js";
import { computeMetrics, detectConfusion } from "./metrics.js";
import type { TriggerProvider, TriggerResult } from "./types.js";
import type { TestCase } from "../schemas/test-case.js";
import type { SkillFrontmatter } from "../schemas/skill-frontmatter.js";

// Mock provider that returns predetermined selections
function mockProvider(
  selections: Record<string, string | null>,
): TriggerProvider {
  return {
    async selectSkill(prompt) {
      const selected = selections[prompt] ?? null;
      return { selected, reasoning: `Mock selected: ${selected ?? "none"}` };
    },
  };
}

const targetFrontmatter: SkillFrontmatter = {
  name: "commit-writer",
  description: "Generates commit messages from diffs.",
};

const siblings = [
  { name: "pr-reviewer", description: "Reviews pull requests for quality issues." },
  { name: "changelog-gen", description: "Generates changelog entries from commits." },
];

describe("roster builder", () => {
  it("builds a single-skill roster", () => {
    const roster = buildRoster(targetFrontmatter);
    expect(roster.target.name).toBe("commit-writer");
    expect(roster.target.isTarget).toBe(true);
    expect(roster.siblings).toHaveLength(0);
    expect(roster.all).toHaveLength(1);
  });

  it("builds a roster with siblings", () => {
    const roster = buildRoster(targetFrontmatter, siblings);
    expect(roster.all).toHaveLength(3);
    expect(roster.siblings).toHaveLength(2);
    expect(roster.siblings[0].isTarget).toBe(false);
  });

  it("formats roster as text", () => {
    const roster = buildRoster(targetFrontmatter, siblings);
    const text = formatRoster(roster);
    expect(text).toContain("commit-writer");
    expect(text).toContain("pr-reviewer");
    expect(text).toContain("changelog-gen");
  });
});

describe("trigger runner", () => {
  const testCases: TestCase[] = [
    { id: "tc1", description: "Should trigger", tier: "core", prompt: "Write a commit message", trigger_expectation: "should_trigger" },
    { id: "tc2", description: "Should not trigger", tier: "core", prompt: "What is the weather?", trigger_expectation: "should_not_trigger" },
    { id: "tc3", description: "Sibling confusion", tier: "core", prompt: "Generate changelog", trigger_expectation: "should_trigger" },
    { id: "tc4", description: "No trigger expectation", tier: "core", prompt: "Hello" },
  ];

  it("classifies correct trigger", async () => {
    const provider = mockProvider({ "Write a commit message": "commit-writer" });
    const roster = buildRoster(targetFrontmatter, siblings);
    const results = await runTriggerTests([testCases[0]], roster, provider);
    expect(results[0].outcome).toBe("correct_trigger");
  });

  it("classifies correct no-trigger", async () => {
    const provider = mockProvider({ "What is the weather?": null });
    const roster = buildRoster(targetFrontmatter, siblings);
    const results = await runTriggerTests([testCases[1]], roster, provider);
    expect(results[0].outcome).toBe("correct_no_trigger");
  });

  it("classifies false positive", async () => {
    const provider = mockProvider({ "What is the weather?": "commit-writer" });
    const roster = buildRoster(targetFrontmatter, siblings);
    const results = await runTriggerTests([testCases[1]], roster, provider);
    expect(results[0].outcome).toBe("false_positive");
  });

  it("classifies false negative", async () => {
    const provider = mockProvider({ "Write a commit message": null });
    const roster = buildRoster(targetFrontmatter, siblings);
    const results = await runTriggerTests([testCases[0]], roster, provider);
    expect(results[0].outcome).toBe("false_negative");
  });

  it("classifies sibling confusion", async () => {
    const provider = mockProvider({ "Generate changelog": "changelog-gen" });
    const roster = buildRoster(targetFrontmatter, siblings);
    const results = await runTriggerTests([testCases[2]], roster, provider);
    expect(results[0].outcome).toBe("sibling_confusion");
  });

  it("skips test cases without trigger expectations", async () => {
    const provider = mockProvider({});
    const roster = buildRoster(targetFrontmatter);
    const results = await runTriggerTests(testCases, roster, provider);
    expect(results).toHaveLength(3); // tc4 is skipped
  });

  it("handles provider errors gracefully", async () => {
    const provider: TriggerProvider = {
      async selectSkill() { throw new Error("API down"); },
    };
    const roster = buildRoster(targetFrontmatter);
    const results = await runTriggerTests([testCases[0]], roster, provider);
    expect(results[0].outcome).toBe("error");
    expect(results[0].reasoning).toContain("API down");
  });
});

describe("trigger metrics", () => {
  it("computes metrics from results", () => {
    const results: TriggerResult[] = [
      { test_case_id: "1", prompt: "a", expected: "should_trigger", outcome: "correct_trigger", selected_skill: "s", reasoning: "" },
      { test_case_id: "2", prompt: "b", expected: "should_trigger", outcome: "correct_trigger", selected_skill: "s", reasoning: "" },
      { test_case_id: "3", prompt: "c", expected: "should_not_trigger", outcome: "correct_no_trigger", selected_skill: null, reasoning: "" },
      { test_case_id: "4", prompt: "d", expected: "should_trigger", outcome: "false_negative", selected_skill: null, reasoning: "" },
      { test_case_id: "5", prompt: "e", expected: "should_not_trigger", outcome: "false_positive", selected_skill: "s", reasoning: "" },
    ];

    const metrics = computeMetrics(results);
    expect(metrics.total_cases).toBe(5);
    expect(metrics.true_positives).toBe(2);
    expect(metrics.true_negatives).toBe(1);
    expect(metrics.false_positives).toBe(1);
    expect(metrics.false_negatives).toBe(1);
    expect(metrics.precision).toBeCloseTo(2 / 3);
    expect(metrics.recall).toBeCloseTo(2 / 3);
  });

  it("handles perfect scores", () => {
    const results: TriggerResult[] = [
      { test_case_id: "1", prompt: "a", expected: "should_trigger", outcome: "correct_trigger", selected_skill: "s", reasoning: "" },
      { test_case_id: "2", prompt: "b", expected: "should_not_trigger", outcome: "correct_no_trigger", selected_skill: null, reasoning: "" },
    ];

    const metrics = computeMetrics(results);
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
    expect(metrics.false_positive_rate).toBe(0);
    expect(metrics.false_negative_rate).toBe(0);
  });

  it("handles empty results", () => {
    const metrics = computeMetrics([]);
    expect(metrics.total_cases).toBe(0);
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
  });
});

describe("confusion detection", () => {
  it("detects confusion pairs", () => {
    const results: TriggerResult[] = [
      { test_case_id: "1", prompt: "a", expected: "should_trigger", outcome: "sibling_confusion", selected_skill: "changelog-gen", reasoning: "" },
      { test_case_id: "2", prompt: "b", expected: "should_trigger", outcome: "sibling_confusion", selected_skill: "changelog-gen", reasoning: "" },
      { test_case_id: "3", prompt: "c", expected: "should_trigger", outcome: "sibling_confusion", selected_skill: "pr-reviewer", reasoning: "" },
      { test_case_id: "4", prompt: "d", expected: "should_trigger", outcome: "correct_trigger", selected_skill: "commit-writer", reasoning: "" },
    ];

    const pairs = detectConfusion(results, "commit-writer");
    expect(pairs).toHaveLength(2);

    const changelogPair = pairs.find((p) => p.skill_b === "changelog-gen");
    expect(changelogPair?.confused_cases).toHaveLength(2);
    expect(changelogPair?.overlap_rate).toBeCloseTo(0.5);
  });

  it("returns empty when no confusion", () => {
    const results: TriggerResult[] = [
      { test_case_id: "1", prompt: "a", expected: "should_trigger", outcome: "correct_trigger", selected_skill: "s", reasoning: "" },
    ];
    expect(detectConfusion(results, "s")).toHaveLength(0);
  });
});
