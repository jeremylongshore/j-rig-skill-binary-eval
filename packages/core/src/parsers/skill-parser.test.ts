import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillMd, parseSkillMdEnterprise } from "./skill-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../fixtures");

function readFixture(path: string): string {
  return readFileSync(resolve(fixturesDir, path), "utf-8");
}

describe("parseSkillMd", () => {
  it("parses a valid SKILL.md fixture", () => {
    const content = readFixture("valid/skill.md");
    const result = parseSkillMd(content);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.frontmatter.name).toBe("commit-message-writer");
      expect(result.data.frontmatter.description).toBeTruthy();
      expect(result.data.body).toContain("# Commit Message Writer");
      expect(result.data.body).toContain("## Instructions");
    }
  });

  it("rejects SKILL.md with no frontmatter", () => {
    const content = readFixture("invalid/skill-no-frontmatter.md");
    const result = parseSkillMd(content);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0].message).toContain("no frontmatter");
    }
  });

  it("rejects SKILL.md with invalid name", () => {
    const content = readFixture("invalid/skill-bad-name.md");
    const result = parseSkillMd(content);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.message.includes("kebab-case"))).toBe(true);
    }
  });

  it("rejects first-person description", () => {
    const content = readFixture("invalid/skill-bad-name.md");
    const result = parseSkillMd(content);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some((e) => e.message.includes("third person")),
      ).toBe(true);
    }
  });

  it("extracts body content without frontmatter delimiters", () => {
    const content = readFixture("valid/skill.md");
    const result = parseSkillMd(content);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).not.toContain("---");
      expect(result.data.body.startsWith("#")).toBe(true);
    }
  });
});

describe("parseSkillMdEnterprise", () => {
  it("parses a valid enterprise SKILL.md", () => {
    const content = readFixture("valid/skill.md");
    const result = parseSkillMdEnterprise(content);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.frontmatter.author).toBeTruthy();
      expect(result.data.frontmatter.version).toBe("1.0.0");
      expect(result.data.frontmatter.license).toBe("MIT");
    }
  });

  it("rejects SKILL.md missing enterprise-required fields", () => {
    const content = `---
name: minimal-skill
description: Does something useful when activated by the user.
---

# Minimal Skill

Instructions here.
`;
    const result = parseSkillMdEnterprise(content);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
