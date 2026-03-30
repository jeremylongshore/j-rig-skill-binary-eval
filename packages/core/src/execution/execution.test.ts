import { describe, it, expect } from "vitest";
import { runFunctionalTests, checkOutputExpectations } from "./runner.js";
import type { ExecutionProvider, ObservedOutcome } from "./types.js";
import type { TestCase } from "../schemas/test-case.js";
import type { ParsedSkill } from "../parsers/skill-parser.js";
import type { SkillFrontmatter } from "../schemas/skill-frontmatter.js";

function mockProvider(
  responses: Record<string, { text: string; artifacts?: Array<{ filename: string; content: string }> }>,
): ExecutionProvider {
  return {
    async execute(prompt) {
      const resp = responses[prompt];
      const now = new Date().toISOString();
      if (!resp) throw new Error(`No mock response for: ${prompt}`);
      return {
        text: resp.text,
        artifacts: (resp.artifacts ?? []).map((a) => ({
          ...a,
          type: "text" as const,
          size_bytes: a.content.length,
        })),
        tool_calls: 1,
        meta: {
          started_at: now,
          completed_at: now,
          duration_ms: 100,
          input_tokens: 50,
          output_tokens: 25,
          total_tokens: 75,
          timed_out: false,
        },
      };
    },
  };
}

const skill: ParsedSkill<SkillFrontmatter> = {
  frontmatter: {
    name: "test-skill",
    description: "A test skill for evaluation.",
  },
  body: "# Test Skill\n\nDo the thing.",
};

const testCases: TestCase[] = [
  {
    id: "func-1",
    description: "Basic execution",
    tier: "core",
    prompt: "Do the task",
    expected_output_contains: ["result"],
  },
  {
    id: "func-2",
    description: "Artifact producing",
    tier: "core",
    prompt: "Generate report",
    expected_artifacts: ["report.json"],
  },
  {
    id: "func-3",
    description: "Missing response",
    tier: "edge",
    prompt: "Unknown prompt",
  },
];

describe("runFunctionalTests", () => {
  it("executes test cases and captures outcomes", async () => {
    const provider = mockProvider({
      "Do the task": { text: "Here is the result" },
      "Generate report": {
        text: "Report generated",
        artifacts: [{ filename: "report.json", content: '{"data": true}' }],
      },
    });

    const outcomes = await runFunctionalTests(
      [testCases[0], testCases[1]],
      skill,
      provider,
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].status).toBe("completed");
    expect(outcomes[0].output.text).toContain("result");
    expect(outcomes[1].output.artifacts).toHaveLength(1);
    expect(outcomes[1].output.artifacts[0].filename).toBe("report.json");
  });

  it("handles provider errors gracefully", async () => {
    const provider = mockProvider({});
    const outcomes = await runFunctionalTests([testCases[2]], skill, provider);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].output.error).toBeTruthy();
  });

  it("captures execution metadata", async () => {
    const provider = mockProvider({
      "Do the task": { text: "result" },
    });

    const outcomes = await runFunctionalTests([testCases[0]], skill, provider);
    expect(outcomes[0].meta.duration_ms).toBe(100);
    expect(outcomes[0].meta.input_tokens).toBe(50);
    expect(outcomes[0].meta.timed_out).toBe(false);
  });

  it("passes context to provider", async () => {
    let capturedBody = "";
    const provider: ExecutionProvider = {
      async execute(_prompt, context) {
        capturedBody = context.skill_body;
        const now = new Date().toISOString();
        return {
          text: "ok",
          artifacts: [],
          tool_calls: 0,
          meta: { started_at: now, completed_at: now, duration_ms: 0, timed_out: false },
        };
      },
    };

    await runFunctionalTests([testCases[0]], skill, provider);
    expect(capturedBody).toContain("# Test Skill");
  });
});

describe("checkOutputExpectations", () => {
  const makeOutcome = (text: string, artifacts: string[] = []): ObservedOutcome => ({
    test_case_id: "t1",
    prompt: "test",
    output: {
      text,
      artifacts: artifacts.map((f) => ({ filename: f, content: "", type: "text" as const, size_bytes: 0 })),
      tool_calls: 0,
    },
    meta: {
      started_at: "",
      completed_at: "",
      duration_ms: 0,
      timed_out: false,
    },
    status: "completed",
  });

  it("passes when output contains expected strings", () => {
    const tc: TestCase = {
      id: "t1", description: "test", tier: "core", prompt: "test",
      expected_output_contains: ["hello", "world"],
    };
    const result = checkOutputExpectations(makeOutcome("hello world"), tc);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("fails when output missing expected string", () => {
    const tc: TestCase = {
      id: "t1", description: "test", tier: "core", prompt: "test",
      expected_output_contains: ["missing"],
    };
    const result = checkOutputExpectations(makeOutcome("hello world"), tc);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("missing");
  });

  it("passes when expected artifacts are present", () => {
    const tc: TestCase = {
      id: "t1", description: "test", tier: "core", prompt: "test",
      expected_artifacts: ["report.json"],
    };
    const result = checkOutputExpectations(makeOutcome("", ["report.json"]), tc);
    expect(result.passed).toBe(true);
  });

  it("fails when expected artifact is missing", () => {
    const tc: TestCase = {
      id: "t1", description: "test", tier: "core", prompt: "test",
      expected_artifacts: ["report.json"],
    };
    const result = checkOutputExpectations(makeOutcome("", []), tc);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("report.json");
  });

  it("passes with no expectations", () => {
    const tc: TestCase = { id: "t1", description: "test", tier: "core", prompt: "test" };
    const result = checkOutputExpectations(makeOutcome("anything"), tc);
    expect(result.passed).toBe(true);
  });
});
