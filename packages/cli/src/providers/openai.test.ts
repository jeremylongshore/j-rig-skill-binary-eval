import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenAIStubTriggerProvider,
  OpenAIStubExecutionProvider,
  OpenAIStubJudgeProvider,
} from "./openai.js";
import { StubTriggerProvider, __resetStubBannerForTests } from "./anthropic.js";

/**
 * Negative-test + behavior discipline for the OpenAI stub providers
 * (iaj-E05a: "Provider interface + anthropic + openai stub adapters").
 *
 * These tests prove:
 *
 *  1. The OpenAI stubs obey the SAME opt-in gate as the Anthropic stubs — the
 *     CLI MUST refuse to instantiate an OpenAI stub path when the explicit
 *     env-var opt-in is missing.
 *
 *  2. The banner-once invariant is PROCESS-level, not per-vendor: a run that
 *     instantiates an Anthropic stub and an OpenAI stub still emits exactly
 *     one banner. (This is the property that justifies sharing
 *     `emitStubBanner` rather than re-declaring it per vendor.)
 *
 *  3. The OpenAI stubs are deterministic and vendor-attributable: their
 *     synthetic outputs carry the `[stub:openai]` prefix so a mixed-vendor
 *     stub run is readable.
 */

describe("OpenAI stub-provider constructor enforces opt-in (defense in depth)", () => {
  const originalEnv = process.env.J_RIG_ALLOW_STUB;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.J_RIG_ALLOW_STUB;
    } else {
      process.env.J_RIG_ALLOW_STUB = originalEnv;
    }
    __resetStubBannerForTests();
  });

  it("OpenAIStubTriggerProvider construction REFUSES when J_RIG_ALLOW_STUB is unset", () => {
    delete process.env.J_RIG_ALLOW_STUB;
    expect(() => new OpenAIStubTriggerProvider("gpt-4o")).toThrowError(/REFUSED/);
  });

  it("OpenAIStubExecutionProvider construction REFUSES when J_RIG_ALLOW_STUB is unset", () => {
    delete process.env.J_RIG_ALLOW_STUB;
    expect(() => new OpenAIStubExecutionProvider("gpt-4o")).toThrowError(/REFUSED/);
  });

  it("OpenAIStubJudgeProvider construction REFUSES when J_RIG_ALLOW_STUB is unset", () => {
    delete process.env.J_RIG_ALLOW_STUB;
    expect(() => new OpenAIStubJudgeProvider("gpt-4o")).toThrowError(/REFUSED/);
  });

  it("OpenAIStubTriggerProvider construction REFUSES when J_RIG_ALLOW_STUB is not exactly '1'", () => {
    process.env.J_RIG_ALLOW_STUB = "true";
    expect(() => new OpenAIStubTriggerProvider("gpt-4o")).toThrowError(/REFUSED/);
  });

  it("all three OpenAI stubs construct successfully when J_RIG_ALLOW_STUB is '1'", () => {
    process.env.J_RIG_ALLOW_STUB = "1";
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as unknown as typeof process.stderr.write);
    try {
      expect(() => new OpenAIStubTriggerProvider("gpt-4o")).not.toThrow();
      expect(() => new OpenAIStubExecutionProvider("gpt-4o")).not.toThrow();
      expect(() => new OpenAIStubJudgeProvider("gpt-4o")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("OpenAI stub-provider banner is process-level (shared with Anthropic stubs)", () => {
  let stderrSpy: MockInstance;
  const originalEnv = process.env.J_RIG_ALLOW_STUB;

  beforeEach(() => {
    process.env.J_RIG_ALLOW_STUB = "1";
    __resetStubBannerForTests();
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as unknown as typeof process.stderr.write);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.J_RIG_ALLOW_STUB;
    } else {
      process.env.J_RIG_ALLOW_STUB = originalEnv;
    }
    stderrSpy.mockRestore();
    __resetStubBannerForTests();
  });

  it("constructing an OpenAI stub emits the shared banner once", () => {
    new OpenAIStubTriggerProvider("gpt-4o");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("mixed Anthropic + OpenAI stub construction still emits exactly one banner", () => {
    new StubTriggerProvider("claude-haiku");
    new OpenAIStubTriggerProvider("gpt-4o");
    new OpenAIStubExecutionProvider("gpt-4o");
    new OpenAIStubJudgeProvider("gpt-4o");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAI stub-provider deterministic, vendor-attributable behavior", () => {
  let stderrSpy: MockInstance;
  const originalEnv = process.env.J_RIG_ALLOW_STUB;

  beforeEach(() => {
    process.env.J_RIG_ALLOW_STUB = "1";
    __resetStubBannerForTests();
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as unknown as typeof process.stderr.write);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.J_RIG_ALLOW_STUB;
    } else {
      process.env.J_RIG_ALLOW_STUB = originalEnv;
    }
    stderrSpy.mockRestore();
    __resetStubBannerForTests();
  });

  it("trigger selects the first available skill and tags reasoning [stub:openai]", async () => {
    const provider = new OpenAIStubTriggerProvider("gpt-4o");
    const result = await provider.selectSkill("do the thing", [
      { name: "alpha", description: "first" },
      { name: "beta", description: "second" },
    ]);
    expect(result.selected).toBe("alpha");
    expect(result.reasoning).toContain("[stub:openai]");
    expect(result.reasoning).toContain("gpt-4o");
  });

  it("trigger returns null selection when no skills are available", async () => {
    const provider = new OpenAIStubTriggerProvider("gpt-4o");
    const result = await provider.selectSkill("do the thing", []);
    expect(result.selected).toBeNull();
  });

  it("execution returns a zero-latency synthetic output tagged [stub:openai]", async () => {
    const provider = new OpenAIStubExecutionProvider("gpt-4o");
    const out = await provider.execute("run this", { skill_body: "abc" });
    expect(out.text).toContain("[stub:openai]");
    expect(out.tool_calls).toBe(0);
    expect(out.artifacts).toEqual([]);
    expect(out.meta.duration_ms).toBe(0);
    expect(out.meta.timed_out).toBe(false);
  });

  it("execution honors the per-call model override", async () => {
    const provider = new OpenAIStubExecutionProvider("gpt-4o");
    const out = await provider.execute("run this", { skill_body: "abc" }, { model: "gpt-4o-mini" });
    expect(out.text).toContain("gpt-4o-mini");
  });

  it("judge returns yes at confidence 0.7 tagged [stub:openai]", async () => {
    const provider = new OpenAIStubJudgeProvider("gpt-4o");
    const verdict = await provider.judge("did it satisfy the criterion", "prompt", "output");
    expect(verdict.verdict).toBe("yes");
    expect(verdict.confidence).toBe(0.7);
    expect(verdict.reasoning).toContain("[stub:openai]");
  });
});
