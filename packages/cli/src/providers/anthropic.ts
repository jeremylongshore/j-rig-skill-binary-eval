import type { TriggerProvider } from "@j-rig/core";
import type { ExecutionProvider, ExecutionContext, ExecutionOutput, ExecutionMeta } from "@j-rig/core";
import type { JudgeProvider, JudgmentVerdict } from "@j-rig/core";

/**
 * Stub trigger provider — prints what it would do instead of calling the API.
 *
 * Always selects the first available skill so the trigger pipeline can run
 * end-to-end without an API key. Replace with a real Anthropic SDK call when
 * ready.
 */
export class StubTriggerProvider implements TriggerProvider {
  constructor(private model: string) {}

  async selectSkill(
    prompt: string,
    availableSkills: Array<{ name: string; description: string }>,
  ): Promise<{ selected: string | null; reasoning: string }> {
    const first = availableSkills[0]?.name ?? null;
    return {
      selected: first,
      reasoning: `[stub] Would call ${this.model} to select from [${availableSkills.map((s) => s.name).join(", ")}] for: "${prompt.slice(0, 50)}..."`,
    };
  }
}

/**
 * Stub execution provider — prints what it would do instead of calling the API.
 *
 * Returns a synthetic `ExecutionOutput & { meta: ExecutionMeta }` with zero
 * latency so the functional pipeline can run end-to-end without an API key.
 */
export class StubExecutionProvider implements ExecutionProvider {
  constructor(private model: string) {}

  async execute(
    prompt: string,
    context: ExecutionContext,
    options?: { timeout_ms?: number; model?: string },
  ): Promise<ExecutionOutput & { meta: ExecutionMeta }> {
    const now = new Date().toISOString();
    const effectiveModel = options?.model ?? this.model;

    return {
      text: `[stub] Would call ${effectiveModel} with skill body (${context.skill_body.length} chars) and prompt: "${prompt.slice(0, 50)}..."`,
      artifacts: [],
      tool_calls: 0,
      meta: {
        started_at: now,
        completed_at: now,
        duration_ms: 0,
        timed_out: false,
      },
    };
  }
}

/**
 * Stub judge provider — prints what it would do instead of calling the API.
 *
 * Always returns a "yes" verdict with low confidence so the judgment pipeline
 * can run end-to-end without an API key.
 */
export class StubJudgeProvider implements JudgeProvider {
  constructor(private model: string) {}

  async judge(
    criterion_description: string,
    prompt: string,
    output: string,
    judge_prompt?: string,
  ): Promise<{ verdict: JudgmentVerdict; confidence: number; reasoning: string }> {
    void prompt;
    void output;
    void judge_prompt;
    return {
      verdict: "yes",
      confidence: 0.7,
      reasoning: `[stub] Would call ${this.model} to judge: "${criterion_description.slice(0, 60)}...". Defaulting to yes.`,
    };
  }
}
