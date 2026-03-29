import matter from "gray-matter";
import { SkillFrontmatterSchema, SkillFrontmatterEnterpriseSchema } from "../schemas/index.js";
import type { SkillFrontmatter, SkillFrontmatterEnterprise } from "../schemas/index.js";
import type { ParseError, ParseResult } from "./yaml-parser.js";

/**
 * Parsed SKILL.md representation.
 */
export interface ParsedSkill<T = SkillFrontmatter> {
  frontmatter: T;
  body: string;
}

/**
 * Parse a SKILL.md file into structured frontmatter + markdown body.
 *
 * Uses gray-matter for frontmatter extraction — no regex hacks.
 * Validates frontmatter against the standard-tier schema.
 */
export function parseSkillMd(
  content: string,
): ParseResult<ParsedSkill<SkillFrontmatter>> {
  let parsed: matter.GrayMatterFile<string>;

  try {
    parsed = matter(content);
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          path: "",
          message: `Failed to parse SKILL.md frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  if (!parsed.data || Object.keys(parsed.data).length === 0) {
    return {
      success: false,
      errors: [
        {
          path: "",
          message:
            "SKILL.md has no frontmatter. Expected YAML frontmatter between --- delimiters.",
        },
      ],
    };
  }

  const result = SkillFrontmatterSchema.safeParse(parsed.data);

  if (!result.success) {
    const errors: ParseError[] = result.error.issues.map((issue) => ({
      path: `frontmatter.${issue.path.join(".")}`,
      message: issue.message,
    }));
    return { success: false, errors };
  }

  return {
    success: true,
    data: {
      frontmatter: result.data,
      body: parsed.content.trim(),
    },
  };
}

/**
 * Parse a SKILL.md file with enterprise-tier validation.
 * Requires author, version, license, and allowed-tools.
 */
export function parseSkillMdEnterprise(
  content: string,
): ParseResult<ParsedSkill<SkillFrontmatterEnterprise>> {
  let parsed: matter.GrayMatterFile<string>;

  try {
    parsed = matter(content);
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          path: "",
          message: `Failed to parse SKILL.md frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  if (!parsed.data || Object.keys(parsed.data).length === 0) {
    return {
      success: false,
      errors: [
        {
          path: "",
          message:
            "SKILL.md has no frontmatter. Expected YAML frontmatter between --- delimiters.",
        },
      ],
    };
  }

  const result = SkillFrontmatterEnterpriseSchema.safeParse(parsed.data);

  if (!result.success) {
    const errors: ParseError[] = result.error.issues.map((issue) => ({
      path: `frontmatter.${issue.path.join(".")}`,
      message: issue.message,
    }));
    return { success: false, errors };
  }

  return {
    success: true,
    data: {
      frontmatter: result.data,
      body: parsed.content.trim(),
    },
  };
}
