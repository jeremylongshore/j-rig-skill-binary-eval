import type { TriggerProvider } from "@j-rig/core";
import type {
  ExecutionProvider,
  ExecutionContext,
  ExecutionOutput,
  ExecutionMeta,
} from "@j-rig/core";
import type { JudgeProvider, JudgmentVerdict } from "@j-rig/core";

import { assertStubAllowed, emitStubBanner } from "./anthropic.js";

/**
 * OpenAI stub provider adapters — the second reference adapter named in
 * iaj-E05a ("Provider interface + anthropic + openai stub adapters").
 *
 * These are the OpenAI-flavored counterparts to the Anthropic stub providers
 * in `./anthropic.ts`. They implement the SAME `TriggerProvider`,
 * `ExecutionProvider`, and `JudgeProvider` contracts and obey the SAME
 * `J_RIG_ALLOW_STUB=1` opt-in discipline and one-banner-per-process rule.
 *
 * Why share `assertStubAllowed` + `emitStubBanner` rather than re-declare them
 * here: the opt-in gate and the banner-once flag are PROCESS-level invariants,
 * not per-vendor ones. A run that instantiates an Anthropic stub and an OpenAI
 * stub in the same process must still emit exactly one banner and must still
 * be governed by a single env-var opt-in. Re-importing the shared primitives
 * from `./anthropic.ts` keeps that invariant structurally true; duplicating
 * them would split the banner-once flag and let a mixed-vendor run print two
 * banners. The shared helpers are vendor-neutral (they say "STUB PROVIDER
 * MODE", not "Anthropic"), so re-use is correct, not a leak.
 *
 * The only thing that differs from the Anthropic stubs is the default model
 * identifier convention (`gpt-*` / `openai/...`) and the `[stub:openai]`
 * reasoning prefix, so a human reading a mixed-vendor stub run can tell which
 * vendor each synthetic row would have hit.
 *
 * Per STUB-PROVIDERS.md: stub output is NOT ground truth. When the real
 * OpenAI SDK adapter lands, real `OpenAITriggerProvider` /
 * `OpenAIExecutionProvider` / `OpenAIJudgeProvider` classes implement these
 * same interfaces and `eval.ts` selects between real and stub on key presence
 * (`OPENAI_API_KEY` set → real; unset AND `J_RIG_ALLOW_STUB=1` → stub).
 */

/** Reasoning-string prefix so mixed-vendor stub runs are visually attributable. */
const STUB_PREFIX = "[stub:openai]";

/**
 * OpenAI stub trigger provider — prints what it would do instead of calling
 * the API. Always selects the first available skill so the trigger pipeline
 * can run end-to-end without an API key.
 *
 * Constructing this class enforces the `J_RIG_ALLOW_STUB=1` opt-in gate
 * (defense in depth: the gate is structurally inviolable, not merely enforced
 * by the known caller) and emits the shared stub-provider banner once per
 * process. Any direct importer who tries to instantiate the stub without the
 * env-var opt-in throws REFUSED.
 */
export class OpenAIStubTriggerProvider implements TriggerProvider {
  constructor(private model: string) {
    assertStubAllowed();
    emitStubBanner();
  }

  async selectSkill(
    prompt: string,
    availableSkills: Array<{ name: string; description: string }>,
  ): Promise<{ selected: string | null; reasoning: string }> {
    const first = availableSkills[0]?.name ?? null;
    return {
      selected: first,
      reasoning: `${STUB_PREFIX} Would call ${this.model} to select from [${availableSkills.map((s) => s.name).join(", ")}] for: "${prompt.slice(0, 50)}..."`,
    };
  }
}

/**
 * OpenAI stub execution provider — prints what it would do instead of calling
 * the API. Returns a synthetic `ExecutionOutput & { meta: ExecutionMeta }`
 * with zero latency so the functional pipeline can run end-to-end without an
 * API key.
 *
 * Constructor enforces the `J_RIG_ALLOW_STUB=1` opt-in gate (see
 * `OpenAIStubTriggerProvider` rationale). Any caller who instantiates without
 * the env-var opt-in throws REFUSED.
 */
export class OpenAIStubExecutionProvider implements ExecutionProvider {
  constructor(private model: string) {
    assertStubAllowed();
    emitStubBanner();
  }

  async execute(
    prompt: string,
    context: ExecutionContext,
    options?: { timeout_ms?: number; model?: string },
  ): Promise<ExecutionOutput & { meta: ExecutionMeta }> {
    const now = new Date().toISOString();
    const effectiveModel = options?.model ?? this.model;

    return {
      text: `${STUB_PREFIX} Would call ${effectiveModel} with skill body (${context.skill_body.length} chars) and prompt: "${prompt.slice(0, 50)}..."`,
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
 * OpenAI stub judge provider — prints what it would do instead of calling the
 * API. Always returns a "yes" verdict with low confidence so the judgment
 * pipeline can run end-to-end without an API key.
 *
 * Constructor enforces the `J_RIG_ALLOW_STUB=1` opt-in gate (see
 * `OpenAIStubTriggerProvider` rationale). Any caller who instantiates without
 * the env-var opt-in throws REFUSED.
 */
export class OpenAIStubJudgeProvider implements JudgeProvider {
  constructor(private model: string) {
    assertStubAllowed();
    emitStubBanner();
  }

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
      reasoning: `${STUB_PREFIX} Would call ${this.model} to judge: "${criterion_description.slice(0, 60)}...". Defaulting to yes.`,
    };
  }
}
