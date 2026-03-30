import type { TestCase } from "../schemas/test-case.js";
import type { ParsedSkill } from "../parsers/skill-parser.js";
import type { SkillFrontmatter } from "../schemas/skill-frontmatter.js";
import type {
  ExecutionContext,
  ExecutionProvider,
  ObservedOutcome,
} from "./types.js";

/**
 * Run functional execution tests for a skill against test cases.
 *
 * Uses the provided ExecutionProvider to simulate skill invocation.
 * Captures outputs, artifacts, and execution metadata.
 */
export async function runFunctionalTests(
  testCases: TestCase[],
  skill: ParsedSkill<SkillFrontmatter>,
  provider: ExecutionProvider,
  options?: {
    base_path?: string;
    file_contents?: Record<string, string>;
    timeout_ms?: number;
    model?: string;
  },
): Promise<ObservedOutcome[]> {
  const outcomes: ObservedOutcome[] = [];

  // Only run test cases that don't have trigger-only expectations
  const functionalCases = testCases.filter(
    (tc) => tc.tier !== "adversarial" || tc.expected_output_contains || tc.expected_artifacts,
  );

  for (const tc of functionalCases) {
    const context: ExecutionContext = {
      skill_body: skill.body,
      base_path: options?.base_path,
      file_contents: options?.file_contents,
      context_hints: tc.context_hints,
    };

    try {
      const result = await provider.execute(tc.prompt, context, {
        timeout_ms: options?.timeout_ms,
        model: options?.model,
      });

      outcomes.push({
        test_case_id: tc.id,
        prompt: tc.prompt,
        output: {
          text: result.text,
          artifacts: result.artifacts,
          tool_calls: result.tool_calls,
          error: result.error,
        },
        meta: result.meta,
        status: result.meta.timed_out ? "timed_out" : "completed",
      });
    } catch (err) {
      const now = new Date().toISOString();
      outcomes.push({
        test_case_id: tc.id,
        prompt: tc.prompt,
        output: {
          text: "",
          artifacts: [],
          tool_calls: 0,
          error: err instanceof Error ? err.message : String(err),
        },
        meta: {
          started_at: now,
          completed_at: now,
          duration_ms: 0,
          timed_out: false,
        },
        status: "failed",
      });
    }
  }

  return outcomes;
}

/**
 * Check if an observed outcome meets the expected output criteria
 * from the test case (deterministic output checks, not judge-based).
 */
export function checkOutputExpectations(
  outcome: ObservedOutcome,
  testCase: TestCase,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];

  if (testCase.expected_output_contains) {
    for (const expected of testCase.expected_output_contains) {
      if (!outcome.output.text.includes(expected)) {
        failures.push(`Output missing expected string: "${expected}"`);
      }
    }
  }

  if (testCase.expected_artifacts) {
    for (const expectedFile of testCase.expected_artifacts) {
      const found = outcome.output.artifacts.some(
        (a) => a.filename === expectedFile,
      );
      if (!found) {
        failures.push(`Expected artifact not produced: "${expectedFile}"`);
      }
    }
  }

  return { passed: failures.length === 0, failures };
}
