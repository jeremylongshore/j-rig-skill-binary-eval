import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StubTriggerProvider,
  StubExecutionProvider,
  StubJudgeProvider,
  assertStubAllowed,
  emitStubBanner,
  __resetStubBannerForTests,
} from "./anthropic.js";

/**
 * Negative-test discipline for the stub providers per IEP Convergence Debt
 * Plan Priority 2 (iaj-stub-negative-test).
 *
 * These tests prove the two non-negotiable invariants of stub mode:
 *
 *  1. Stub mode is OPT-IN. The CLI MUST refuse to instantiate a stub path
 *     when the explicit env-var opt-in is missing.
 *
 *  2. When stub mode IS active, every invocation MUST emit a loud banner
 *     to stderr exactly once per process so neither human reviewers nor
 *     CI logs can mistake stub output for ground truth.
 *
 * Reference: STUB-PROVIDERS.md at the repo root.
 */

describe("stub-provider opt-in gate (assertStubAllowed)", () => {
  const originalEnv = process.env.J_RIG_ALLOW_STUB;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.J_RIG_ALLOW_STUB;
    } else {
      process.env.J_RIG_ALLOW_STUB = originalEnv;
    }
  });

  it("REFUSES when J_RIG_ALLOW_STUB is unset", () => {
    delete process.env.J_RIG_ALLOW_STUB;
    expect(() => assertStubAllowed()).toThrowError(/REFUSED/);
    expect(() => assertStubAllowed()).toThrowError(/J_RIG_ALLOW_STUB=1/);
    expect(() => assertStubAllowed()).toThrowError(/STUB-PROVIDERS\.md/);
  });

  it("REFUSES when J_RIG_ALLOW_STUB is set to anything other than '1'", () => {
    process.env.J_RIG_ALLOW_STUB = "true";
    expect(() => assertStubAllowed()).toThrowError(/REFUSED/);

    process.env.J_RIG_ALLOW_STUB = "yes";
    expect(() => assertStubAllowed()).toThrowError(/REFUSED/);

    process.env.J_RIG_ALLOW_STUB = "0";
    expect(() => assertStubAllowed()).toThrowError(/REFUSED/);

    process.env.J_RIG_ALLOW_STUB = "";
    expect(() => assertStubAllowed()).toThrowError(/REFUSED/);
  });

  it("PERMITS only when J_RIG_ALLOW_STUB is exactly '1'", () => {
    process.env.J_RIG_ALLOW_STUB = "1";
    expect(() => assertStubAllowed()).not.toThrow();
  });
});

describe("stub-provider banner (emitStubBanner)", () => {
  // `process.stderr.write` has overloaded signatures that vitest's MockInstance
  // generic cannot widen — use the unparameterised MockInstance and cast at use.
  let stderrSpy: MockInstance;
  const originalEnv = process.env.J_RIG_ALLOW_STUB;

  beforeEach(() => {
    // Stub constructors enforce the opt-in gate (defense in depth) — every
    // test that instantiates a stub must satisfy that gate explicitly.
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

  it("writes the banner to stderr exactly once per process", () => {
    emitStubBanner();
    emitStubBanner();
    emitStubBanner();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("declares stub mode + 'NOT ground truth' explicitly", () => {
    emitStubBanner();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const banner = stderrSpy.mock.calls[0]?.[0] as string;
    expect(banner).toContain("WARNING");
    expect(banner).toContain("STUB PROVIDER MODE");
    expect(banner).toContain("NOT ground truth");
    expect(banner).toContain("J_RIG_ALLOW_STUB=1");
    expect(banner).toContain("STUB-PROVIDERS.md");
  });

  it("constructs StubTriggerProvider emits the banner", () => {
    new StubTriggerProvider("claude-haiku");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("constructs StubExecutionProvider emits the banner", () => {
    new StubExecutionProvider("claude-haiku");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("constructs StubJudgeProvider emits the banner", () => {
    new StubJudgeProvider("claude-haiku");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("multiple stub constructions in the same process still emit exactly one banner", () => {
    new StubTriggerProvider("claude-haiku");
    new StubExecutionProvider("claude-haiku");
    new StubJudgeProvider("claude-haiku");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("writes to stderr, not stdout (preserves --json output cleanliness)", () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as unknown as typeof process.stdout.write);
    emitStubBanner();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});

describe("stub-provider constructor enforces opt-in (defense in depth)", () => {
  // Per Gemini review on PR #75: moving the assertStubAllowed() call into
  // each stub provider constructor makes the safety invariant structurally
  // inviolable — any caller who tries to import a stub provider directly
  // and instantiate it without J_RIG_ALLOW_STUB=1 hits the gate, not just
  // callers who go through the eval.ts command handler.
  const originalEnv = process.env.J_RIG_ALLOW_STUB;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.J_RIG_ALLOW_STUB;
    } else {
      process.env.J_RIG_ALLOW_STUB = originalEnv;
    }
    __resetStubBannerForTests();
  });

  it("StubTriggerProvider construction REFUSES when J_RIG_ALLOW_STUB is unset", () => {
    delete process.env.J_RIG_ALLOW_STUB;
    expect(() => new StubTriggerProvider("claude-haiku")).toThrowError(/REFUSED/);
  });

  it("StubExecutionProvider construction REFUSES when J_RIG_ALLOW_STUB is unset", () => {
    delete process.env.J_RIG_ALLOW_STUB;
    expect(() => new StubExecutionProvider("claude-haiku")).toThrowError(/REFUSED/);
  });

  it("StubJudgeProvider construction REFUSES when J_RIG_ALLOW_STUB is unset", () => {
    delete process.env.J_RIG_ALLOW_STUB;
    expect(() => new StubJudgeProvider("claude-haiku")).toThrowError(/REFUSED/);
  });

  it("StubTriggerProvider construction REFUSES when J_RIG_ALLOW_STUB is not exactly '1'", () => {
    process.env.J_RIG_ALLOW_STUB = "true";
    expect(() => new StubTriggerProvider("claude-haiku")).toThrowError(/REFUSED/);
  });

  it("all three stubs construct successfully when J_RIG_ALLOW_STUB is '1'", () => {
    process.env.J_RIG_ALLOW_STUB = "1";
    // Suppress banner so test output isn't noisy.
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as unknown as typeof process.stderr.write);
    try {
      expect(() => new StubTriggerProvider("claude-haiku")).not.toThrow();
      expect(() => new StubExecutionProvider("claude-haiku")).not.toThrow();
      expect(() => new StubJudgeProvider("claude-haiku")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
