import type { TriggerProvider } from "@j-rig/core";
import type { ExecutionProvider, ExecutionContext, ExecutionOutput, ExecutionMeta } from "@j-rig/core";
import type { JudgeProvider, JudgmentVerdict } from "@j-rig/core";

/**
 * Stub-provider banner.
 *
 * Per IEP Convergence Debt Plan Priority 2 (iaj-stub-provider): stub-provider
 * output is NOT ground truth. Every CLI invocation that instantiates a stub
 * MUST emit this banner to stderr exactly once, before any synthetic output
 * is produced.
 *
 * The banner is written to stderr so it never pollutes structured stdout
 * (e.g., `--json` output). The flag below is module-scoped so the banner
 * fires once per process — multiple stub instantiations don't spam stderr.
 *
 * See STUB-PROVIDERS.md at the repo root for the full discipline.
 */
let stubBannerEmitted = false;

export function emitStubBanner(): void {
  if (stubBannerEmitted) return;
  stubBannerEmitted = true;
  // Use process.stderr directly so the banner is preserved even when stdout
  // is being captured for structured output (e.g., piped to jq).
  process.stderr.write(
    [
      "",
      "╔════════════════════════════════════════════════════════════════════════════╗",
      "║  WARNING — j-rig STUB PROVIDER MODE                                        ║",
      "║                                                                            ║",
      "║  This run is using STUB providers. Output is NOT ground truth.             ║",
      "║  Stub Trigger:    always selects the first available skill                 ║",
      "║  Stub Execution:  returns a synthetic response with zero latency           ║",
      "║  Stub Judgment:   always returns 'yes' with confidence 0.7                 ║",
      "║                                                                            ║",
      "║  These outputs are placeholder values for pipeline plumbing only.          ║",
      "║  Do NOT treat any metric, decision, or rollout verdict from this run as    ║",
      "║  evidence of skill quality. CI gates that consume j-rig output MUST        ║",
      "║  refuse rows produced under stub mode.                                     ║",
      "║                                                                            ║",
      "║  To run against a real provider: implement the Anthropic SDK adapter       ║",
      "║  (see STUB-PROVIDERS.md). To acknowledge stub mode: set the env var        ║",
      "║  J_RIG_ALLOW_STUB=1 before invocation.                                     ║",
      "╚════════════════════════════════════════════════════════════════════════════╝",
      "",
    ].join("\n"),
  );
}

/**
 * Reset the banner-once flag. ONLY for use in tests that need a fresh
 * banner emission per test case. Production code paths must never call this.
 */
export function __resetStubBannerForTests(): void {
  stubBannerEmitted = false;
}

/**
 * Refuse to enter stub mode unless explicitly authorized.
 *
 * Stub mode is opt-in via the J_RIG_ALLOW_STUB env var. Without explicit
 * authorization, any code path that would instantiate a stub provider MUST
 * throw — the failure mode of silently emitting synthetic ship verdicts is
 * too costly. Per IEP Convergence Debt Plan Priority 2.
 *
 * The env-var name is intentionally explicit (not e.g. NODE_ENV=test) so
 * CI configs that opt in record the decision visibly in their workflow YAML.
 */
export function assertStubAllowed(): void {
  if (process.env.J_RIG_ALLOW_STUB === "1") return;
  throw new Error(
    [
      "REFUSED: j-rig cannot run without a real provider implementation.",
      "",
      "The Anthropic SDK adapter is not yet wired (iaj-stub-provider, PB-7). To opt",
      "into stub mode for pipeline-plumbing development, set:",
      "",
      "    J_RIG_ALLOW_STUB=1",
      "",
      "BEFORE running the CLI. Stub-mode results are NOT ground truth — see",
      "STUB-PROVIDERS.md for the full discipline.",
    ].join("\n"),
  );
}

/**
 * Stub trigger provider — prints what it would do instead of calling the API.
 *
 * Always selects the first available skill so the trigger pipeline can run
 * end-to-end without an API key. Replace with a real Anthropic SDK call when
 * ready.
 *
 * Constructing this class emits the stub-provider banner once per process.
 */
export class StubTriggerProvider implements TriggerProvider {
  constructor(private model: string) {
    emitStubBanner();
  }

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
  constructor(private model: string) {
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
  constructor(private model: string) {
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
      reasoning: `[stub] Would call ${this.model} to judge: "${criterion_description.slice(0, 60)}...". Defaulting to yes.`,
    };
  }
}
