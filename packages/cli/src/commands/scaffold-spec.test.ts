import { describe, it, expect } from "vitest";
import { EvalSpecSchema } from "@j-rig/core";
import { buildBaselineSpec, deriveTriggerPrompts, toKebab } from "./scaffold-spec.js";

const SKILL_NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

describe("scaffold-spec — toKebab (kernel skill_name compliance)", () => {
  it("kebabs normal names", () => {
    expect(toKebab("Doc Filing v4.4")).toBe("doc-filing-v4-4");
  });
  it("prefixes a letter when the name starts with a digit", () => {
    const k = toKebab("2fa-helper");
    expect(k).toMatch(SKILL_NAME_RE);
    expect(k).toBe("s-2fa-helper");
  });
  it("pads a single-character name to satisfy the min-length regex", () => {
    expect(toKebab("X")).toMatch(SKILL_NAME_RE);
  });
  it("returns '' when nothing usable remains (caller falls back)", () => {
    expect(toKebab("!!!")).toBe("");
  });
});

describe("scaffold-spec — deriveTriggerPrompts", () => {
  it("extracts natural-language quoted trigger phrases from a description", () => {
    const desc =
      'Organizes documents. Trigger with "organize docs", "file documents", or "/doc-filing".';
    const prompts = deriveTriggerPrompts(desc);
    expect(prompts).toContain("organize docs");
    expect(prompts).toContain("file documents");
    // bare slash tokens are not natural-language prompts
    expect(prompts).not.toContain("/doc-filing");
    expect(prompts.length).toBeLessThanOrEqual(2);
  });

  it("falls back to a templated request when no quoted phrases exist", () => {
    const prompts = deriveTriggerPrompts(
      "Audits a codebase for security issues and produces a report.",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^Help me with this:/);
    expect(prompts[0]).toContain("Audits a codebase");
  });

  it("dedupes repeated quoted phrases", () => {
    const prompts = deriveTriggerPrompts('Use "do the thing" or "do the thing" again.');
    expect(prompts).toEqual(["do the thing"]);
  });
});

describe("scaffold-spec — buildBaselineSpec", () => {
  it("produces a spec that validates against the kernel EvalSpecSchema", () => {
    const spec = buildBaselineSpec("my-skill", 'Does a useful thing. Trigger with "do the thing".');
    const parsed = EvalSpecSchema.safeParse(spec);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("carries the generic-but-real criteria set + honest provenance tag", () => {
    const spec = buildBaselineSpec("my-skill", "Does a thing.");
    const ids = spec.criteria.map((c) => (c as { id: string }).id);
    expect(ids).toEqual(["output-not-empty", "engages-with-stated-intent", "no-prompt-leakage"]);
    expect(spec.tags).toContain("generated");
    expect(spec.models).toEqual(["sonnet"]);
  });

  it("scopes control (should_not_trigger) cases to NO functional criteria (avoids false blockers)", () => {
    const spec = buildBaselineSpec("my-skill", "Does a thing.");
    const controls = spec.test_cases.filter(
      (t) => (t as { trigger_expectation?: string }).trigger_expectation === "should_not_trigger",
    );
    expect(controls.length).toBeGreaterThanOrEqual(1);
    for (const c of controls) {
      expect((c as { criteria_ids: string[] }).criteria_ids).toEqual([]);
    }
  });

  it("includes an adversarial injection case scoped to prompt-leakage", () => {
    const spec = buildBaselineSpec("my-skill", "Does a thing.");
    const adv = spec.test_cases.find((t) => (t as { tier: string }).tier === "adversarial") as
      { criteria_ids: string[] } | undefined;
    expect(adv).toBeDefined();
    expect(adv!.criteria_ids).toEqual(["no-prompt-leakage"]);
  });
});
