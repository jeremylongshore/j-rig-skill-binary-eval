import { describe, expect, it } from "vitest";
import { classifyField, isValidEffort, loadSpecAuthority } from "./spec-sources.js";

describe("spec-sources", () => {
  describe("loadSpecAuthority", () => {
    it("returns a frozen authority object", () => {
      const authority = loadSpecAuthority();
      expect(Object.isFrozen(authority)).toBe(true);
    });

    it("loads snapshot IDs from references/specs/", () => {
      const authority = loadSpecAuthority();
      // Initial seed snapshots are dated 2026-05-07. If snapshot files are
      // missing the loader returns "missing"; if found it pulls the ID from
      // the **Snapshot ID** header line.
      expect(authority.anthropicSnapshotId).not.toBe("");
      expect(authority.agentskillsSnapshotId).not.toBe("");
    });

    it("declares Anthropic required fields as exactly name + description", () => {
      const authority = loadSpecAuthority();
      expect([...authority.anthropicRequiredFields].sort()).toEqual(["description", "name"]);
    });

    it("includes documented optional fields per Anthropic snapshot", () => {
      const authority = loadSpecAuthority();
      // Spot-check key fields documented at code.claude.com/docs/en/skills
      expect(authority.anthropicOptionalFields).toContain("allowed-tools");
      expect(authority.anthropicOptionalFields).toContain("model");
      expect(authority.anthropicOptionalFields).toContain("effort");
      expect(authority.anthropicOptionalFields).toContain("when_to_use");
      expect(authority.anthropicOptionalFields).toContain("compatibility");
    });

    it("declares effort valid values as low/medium/high/xhigh/max", () => {
      const authority = loadSpecAuthority();
      expect([...authority.validEffortValues].sort()).toEqual([
        "high",
        "low",
        "max",
        "medium",
        "xhigh",
      ]);
    });

    it("includes ${CLAUDE_EFFORT} substitution variable (added in 3.3.1)", () => {
      const authority = loadSpecAuthority();
      expect(authority.substitutionVariables).toContain("${CLAUDE_EFFORT}");
      expect(authority.substitutionVariables).toContain("${CLAUDE_SKILL_DIR}");
      expect(authority.substitutionVariables).toContain("${CLAUDE_PLUGIN_ROOT}");
    });

    it("enforces AgentSkills.io compatibility max-length at 500 chars", () => {
      const authority = loadSpecAuthority();
      expect(authority.agentskillsCompatibilityMaxChars).toBe(500);
    });

    it("enforces Anthropic description-combined-cap at 1536 chars", () => {
      const authority = loadSpecAuthority();
      expect(authority.anthropicDescriptionCombinedCap).toBe(1536);
    });
  });

  describe("classifyField", () => {
    it("classifies name and description as required", () => {
      expect(classifyField("name")).toBe("required");
      expect(classifyField("description")).toBe("required");
    });

    it("classifies allowed-tools as optional", () => {
      expect(classifyField("allowed-tools")).toBe("optional");
    });

    it("classifies model / effort / when_to_use as optional", () => {
      expect(classifyField("model")).toBe("optional");
      expect(classifyField("effort")).toBe("optional");
      expect(classifyField("when_to_use")).toBe("optional");
    });

    it("classifies unknown / IS-extension fields as unknown", () => {
      // 'tags', 'version', 'author' are IS enterprise-required at marketplace
      // tier but NOT part of the Anthropic spec. The spec authority returns
      // "unknown" for these — downstream IS rubrics layer on top.
      expect(classifyField("tags")).toBe("unknown");
      expect(classifyField("version")).toBe("unknown");
      expect(classifyField("author")).toBe("unknown");
      expect(classifyField("madeUpField")).toBe("unknown");
    });
  });

  describe("isValidEffort", () => {
    it.each(["low", "medium", "high", "xhigh", "max"])("accepts %s", (value) => {
      expect(isValidEffort(value)).toBe(true);
    });

    it.each(["LOW", "ultra", "extreme", "", "minimal"])("rejects %s", (value) => {
      expect(isValidEffort(value)).toBe(false);
    });
  });
});
