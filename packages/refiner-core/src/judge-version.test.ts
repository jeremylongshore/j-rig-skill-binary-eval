/**
 * Tests for judge-version.ts — Phase A.0 judge-version pinning (bead 99oc).
 *
 * Covers:
 *   - CONSUMED_JUDGE_VERSION: present and is a non-empty string.
 *   - BaselineJudgeRef: structural round-trip (plain object assignment).
 *   - isBaselineSupersededByJudge: true when versions differ, false when equal.
 *     Covers: identical, lateral change, both-blank, current-blank, baseline-blank.
 *   - VNextBaselineTrigger / makeVNextBaselineTrigger:
 *       carries superseded→current + triggeredAt; old and new are both
 *       retained (the trigger does NOT overwrite either); rejects identical
 *       versions.
 *
 * Design note: judge versions are opaque string identifiers — NOT semver. Any
 * identifier change triggers supersession. Tests verify this symmetric
 * equality-only behavior (as opposed to kernel-version's directional semver
 * comparison). No ordering direction tests (e.g. "newer" / "older") are
 * appropriate here by design.
 *
 * Not mocked: all functions under test are pure; no stubs or spies.
 */

import { describe, it, expect } from "vitest";
import {
  CONSUMED_JUDGE_VERSION,
  isBaselineSupersededByJudge,
  makeVNextBaselineTrigger,
} from "./judge-version.js";
import type { BaselineJudgeRef, VNextBaselineTrigger } from "./judge-version.js";

// ── CONSUMED_JUDGE_VERSION ────────────────────────────────────────────────────

describe("CONSUMED_JUDGE_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof CONSUMED_JUDGE_VERSION).toBe("string");
    expect(CONSUMED_JUDGE_VERSION.length).toBeGreaterThan(0);
  });

  it("does not look like a semver triple (judge versions are opaque identifiers)", () => {
    // Judge versions are model identifiers (e.g. "claude-sonnet-4-5"), not
    // semver strings. A valid judge version must NOT be a bare "N.N.N" string.
    // We assert the constant contains at least one non-numeric, non-dot char.
    expect(CONSUMED_JUDGE_VERSION).toMatch(/[^0-9.]/);
  });

  it("is not superseded by itself", () => {
    expect(isBaselineSupersededByJudge(CONSUMED_JUDGE_VERSION, CONSUMED_JUDGE_VERSION)).toBe(false);
  });
});

// ── BaselineJudgeRef (structural round-trip) ──────────────────────────────────

describe("BaselineJudgeRef", () => {
  it("round-trips as a plain object assignment", () => {
    const ref: BaselineJudgeRef = { judgeVersion: "claude-sonnet-4-5" };
    expect(ref.judgeVersion).toBe("claude-sonnet-4-5");
  });

  it("accepts CONSUMED_JUDGE_VERSION as a valid judgeVersion value", () => {
    const ref: BaselineJudgeRef = { judgeVersion: CONSUMED_JUDGE_VERSION };
    expect(ref.judgeVersion).toBe(CONSUMED_JUDGE_VERSION);
  });

  it("accepts an arbitrary opaque judge identifier (non-Anthropic format)", () => {
    const ref: BaselineJudgeRef = { judgeVersion: "gpt-4o-2024-11-20" };
    expect(ref.judgeVersion).toBe("gpt-4o-2024-11-20");
  });
});

// ── isBaselineSupersededByJudge ───────────────────────────────────────────────

describe("isBaselineSupersededByJudge", () => {
  it("returns false when baselineJudgeVersion === currentJudgeVersion (baseline is current)", () => {
    expect(isBaselineSupersededByJudge("claude-sonnet-4-5", "claude-sonnet-4-5")).toBe(false);
  });

  it("returns false when CONSUMED_JUDGE_VERSION is compared to itself", () => {
    expect(isBaselineSupersededByJudge(CONSUMED_JUDGE_VERSION, CONSUMED_JUDGE_VERSION)).toBe(false);
  });

  it("returns true when current judge is a different model in the same family (lateral change)", () => {
    // Sonnet → Opus: a lateral capability swap; both versions differ → superseded.
    expect(isBaselineSupersededByJudge("claude-sonnet-4-5", "claude-opus-4-0")).toBe(true);
  });

  it("returns true when current judge is a newer revision of the same model", () => {
    // Minor revision bump in the model suffix — still a different identifier.
    expect(isBaselineSupersededByJudge("claude-sonnet-4-5", "claude-sonnet-4-6")).toBe(true);
  });

  it("returns true when switching judge providers entirely", () => {
    expect(isBaselineSupersededByJudge("claude-sonnet-4-5", "gpt-4o-2024-11-20")).toBe(true);
  });

  it("returns true regardless of which direction the change goes (symmetric)", () => {
    // A→B and B→A must both be superseded (no ordering semantics on opaque IDs).
    expect(isBaselineSupersededByJudge("claude-opus-4-0", "claude-sonnet-4-5")).toBe(true);
    expect(isBaselineSupersededByJudge("claude-sonnet-4-5", "claude-opus-4-0")).toBe(true);
  });

  it("returns true when either version is an empty string (distinguishable from any real identifier)", () => {
    // An empty string is a valid "different" identifier — not equal to a real one.
    expect(isBaselineSupersededByJudge("", "claude-sonnet-4-5")).toBe(true);
    expect(isBaselineSupersededByJudge("claude-sonnet-4-5", "")).toBe(true);
  });

  it("returns false when both versions are the same empty string", () => {
    // Degenerate case: both sides are empty → equal → not superseded.
    expect(isBaselineSupersededByJudge("", "")).toBe(false);
  });
});

// ── VNextBaselineTrigger / makeVNextBaselineTrigger ───────────────────────────

describe("makeVNextBaselineTrigger", () => {
  it("returns a trigger with the correct superseded→current judge versions", () => {
    const trigger: VNextBaselineTrigger = makeVNextBaselineTrigger(
      "claude-sonnet-4-5",
      "claude-opus-4-0",
      "2026-06-20T12:00:00Z",
    );
    expect(trigger.supersededJudgeVersion).toBe("claude-sonnet-4-5");
    expect(trigger.currentJudgeVersion).toBe("claude-opus-4-0");
    expect(trigger.triggeredAt).toBe("2026-06-20T12:00:00Z");
  });

  it("carries any caller-injected triggeredAt string (no Date.now call in library)", () => {
    const ts = "2099-01-01T00:00:00.000Z";
    const trigger = makeVNextBaselineTrigger("claude-sonnet-4-5", "claude-opus-4-0", ts);
    expect(trigger.triggeredAt).toBe(ts);
  });

  it("retains the old (superseded) judge version on the trigger (not overwritten)", () => {
    // The OLD baseline continues to exist alongside the vNext trigger; the
    // trigger itself carries both IDs so both can be compared explicitly.
    const oldJudge = "claude-sonnet-4-5";
    const newJudge = "claude-sonnet-4-6";
    const trigger = makeVNextBaselineTrigger(oldJudge, newJudge, "2026-06-20T00:00:00Z");
    // Both sides are present on the trigger — neither is lost.
    expect(trigger.supersededJudgeVersion).toBe(oldJudge);
    expect(trigger.currentJudgeVersion).toBe(newJudge);
  });

  it("works for a provider switch (cross-family judge change)", () => {
    const trigger = makeVNextBaselineTrigger(
      "claude-sonnet-4-5",
      "gpt-4o-2024-11-20",
      "2026-06-20T00:00:00Z",
    );
    expect(trigger.supersededJudgeVersion).toBe("claude-sonnet-4-5");
    expect(trigger.currentJudgeVersion).toBe("gpt-4o-2024-11-20");
  });

  it("throws when currentJudgeVersion === supersededJudgeVersion (identical — not superseded)", () => {
    expect(() =>
      makeVNextBaselineTrigger("claude-sonnet-4-5", "claude-sonnet-4-5", "2026-06-20T00:00:00Z"),
    ).toThrow(/identical to supersededJudgeVersion/);
  });

  it("the resulting trigger is a plain object (readonly fields round-trip)", () => {
    const trigger = makeVNextBaselineTrigger(
      "claude-sonnet-4-5",
      "claude-opus-4-0",
      "2026-06-20T10:30:00.000Z",
    );
    const { supersededJudgeVersion, currentJudgeVersion, triggeredAt } = trigger;
    expect(supersededJudgeVersion).toBe("claude-sonnet-4-5");
    expect(currentJudgeVersion).toBe("claude-opus-4-0");
    expect(triggeredAt).toBe("2026-06-20T10:30:00.000Z");
  });
});
