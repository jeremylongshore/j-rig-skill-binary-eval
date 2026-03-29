import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSkillMd } from "../parsers/skill-parser.js";
import type { SkillFrontmatter } from "../schemas/skill-frontmatter.js";
import type { CheckResult, PackageReport } from "./types.js";
import { summarize } from "./types.js";

/** Reference patterns to detect in SKILL.md body. */
const FILE_REF_PATTERN = /\$\{CLAUDE_SKILL_DIR\}\/([\w./-]+)/g;
const PATH_LIKE_PATTERN = /(?:^|\s)(\.\/[\w./-]+)/gm;

/** Thresholds for heuristic checks. */
const MIN_DESCRIPTION_LENGTH = 20;
const MIN_DESCRIPTION_WORDS = 4;
const MAX_BODY_LINES = 500;
const MIN_BODY_LINES = 3;

/**
 * Run all deterministic preflight checks against a skill package directory.
 *
 * Returns a structured PackageReport with hard failures, warnings, and passes.
 */
export function checkPackage(packageDir: string): PackageReport {
  const results: CheckResult[] = [];
  const absDir = resolve(packageDir);

  // 1. Check SKILL.md exists
  const skillPath = join(absDir, "SKILL.md");
  if (!existsSync(skillPath)) {
    results.push({
      id: "pkg:skill-md-exists",
      description: "SKILL.md file exists in package",
      severity: "error",
      message: "SKILL.md not found",
      details: `Expected at: ${skillPath}`,
    });
    return buildReport(null, results);
  }

  results.push({
    id: "pkg:skill-md-exists",
    description: "SKILL.md file exists in package",
    severity: "pass",
    message: "SKILL.md found",
  });

  // 2. Parse SKILL.md
  const content = readFileSync(skillPath, "utf-8");
  const parseResult = parseSkillMd(content);

  if (!parseResult.success) {
    results.push({
      id: "pkg:skill-md-parses",
      description: "SKILL.md frontmatter parses successfully",
      severity: "error",
      message: "SKILL.md failed to parse",
      details: parseResult.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
    });
    return buildReport(null, results);
  }

  const { frontmatter, body } = parseResult.data;

  results.push({
    id: "pkg:skill-md-parses",
    description: "SKILL.md frontmatter parses successfully",
    severity: "pass",
    message: "SKILL.md parsed successfully",
  });

  // 3. Required frontmatter fields
  results.push(...checkRequiredFields(frontmatter));

  // 4. Description quality heuristics
  results.push(...checkDescriptionQuality(frontmatter.description));

  // 5. Body size heuristics
  results.push(...checkBodySize(body));

  // 6. Referenced file validation
  results.push(...checkReferencedFiles(body, absDir));

  return buildReport(frontmatter.name, results);
}

/**
 * Check that required frontmatter fields are present and non-empty.
 */
function checkRequiredFields(fm: SkillFrontmatter): CheckResult[] {
  const results: CheckResult[] = [];

  if (!fm.name || fm.name.trim().length === 0) {
    results.push({
      id: "pkg:name-present",
      description: "Skill name is present",
      severity: "error",
      message: "Skill name is missing or empty",
    });
  } else {
    results.push({
      id: "pkg:name-present",
      description: "Skill name is present",
      severity: "pass",
      message: `Skill name: ${fm.name}`,
    });
  }

  if (!fm.description || fm.description.trim().length === 0) {
    results.push({
      id: "pkg:description-present",
      description: "Skill description is present",
      severity: "error",
      message: "Skill description is missing or empty",
    });
  } else {
    results.push({
      id: "pkg:description-present",
      description: "Skill description is present",
      severity: "pass",
      message: "Skill description present",
    });
  }

  return results;
}

/**
 * Heuristic checks for description quality.
 * These are warnings, not hard failures.
 */
function checkDescriptionQuality(description: string): CheckResult[] {
  const results: CheckResult[] = [];

  // Too short
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    results.push({
      id: "heuristic:description-length",
      description: "Description meets minimum length",
      severity: "warning",
      message: `Description is very short (${description.length} chars, min recommended: ${MIN_DESCRIPTION_LENGTH})`,
    });
  } else {
    results.push({
      id: "heuristic:description-length",
      description: "Description meets minimum length",
      severity: "pass",
      message: "Description length is adequate",
    });
  }

  // Too few words
  const wordCount = description.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_DESCRIPTION_WORDS) {
    results.push({
      id: "heuristic:description-words",
      description: "Description has enough words",
      severity: "warning",
      message: `Description has only ${wordCount} words (min recommended: ${MIN_DESCRIPTION_WORDS})`,
    });
  } else {
    results.push({
      id: "heuristic:description-words",
      description: "Description has enough words",
      severity: "pass",
      message: "Description word count is adequate",
    });
  }

  // Generic/vague patterns
  const vaguePatterns = [
    /^(does|handles|manages|processes|works with)\b/i,
    /^(a|an|the) (tool|helper|utility)\b/i,
    /\b(stuff|things|etc\.?)\b/i,
  ];

  const isVague = vaguePatterns.some((p) => p.test(description));
  if (isVague) {
    results.push({
      id: "heuristic:description-specificity",
      description: "Description is specific enough",
      severity: "warning",
      message: "Description appears vague or generic",
      details: "Consider adding what the skill does, when it triggers, and what it produces",
    });
  } else {
    results.push({
      id: "heuristic:description-specificity",
      description: "Description is specific enough",
      severity: "pass",
      message: "Description appears specific",
    });
  }

  return results;
}

/**
 * Heuristic checks for body size (oversized/underspecified).
 * These are warnings, not hard failures.
 */
function checkBodySize(body: string): CheckResult[] {
  const results: CheckResult[] = [];
  const lineCount = body.split("\n").length;

  if (lineCount > MAX_BODY_LINES) {
    results.push({
      id: "heuristic:body-oversized",
      description: "Body is not excessively large",
      severity: "warning",
      message: `Body is ${lineCount} lines (max recommended: ${MAX_BODY_LINES})`,
      details: "Very large skill bodies may indicate scope creep or embedded data that should be externalized",
    });
  } else {
    results.push({
      id: "heuristic:body-oversized",
      description: "Body is not excessively large",
      severity: "pass",
      message: `Body size is reasonable (${lineCount} lines)`,
    });
  }

  if (lineCount < MIN_BODY_LINES) {
    results.push({
      id: "heuristic:body-underspecified",
      description: "Body has sufficient content",
      severity: "warning",
      message: `Body is very thin (${lineCount} lines, min recommended: ${MIN_BODY_LINES})`,
      details: "Skills with minimal instructions may not provide enough guidance for the model",
    });
  } else {
    results.push({
      id: "heuristic:body-underspecified",
      description: "Body has sufficient content",
      severity: "pass",
      message: "Body has sufficient content",
    });
  }

  return results;
}

/**
 * Check that file references in the SKILL.md body point to real files.
 */
function checkReferencedFiles(body: string, packageDir: string): CheckResult[] {
  const results: CheckResult[] = [];
  const refs = new Set<string>();

  // Collect ${CLAUDE_SKILL_DIR}/... references
  for (const match of body.matchAll(FILE_REF_PATTERN)) {
    refs.add(match[1]);
  }

  // Collect ./relative/path references
  for (const match of body.matchAll(PATH_LIKE_PATTERN)) {
    refs.add(match[1]);
  }

  if (refs.size === 0) {
    return results;
  }

  for (const ref of refs) {
    const absPath = resolve(packageDir, ref);
    if (existsSync(absPath)) {
      try {
        const stat = statSync(absPath);
        results.push({
          id: `ref:${ref}`,
          description: `Referenced file exists: ${ref}`,
          severity: "pass",
          message: `Referenced ${stat.isDirectory() ? "directory" : "file"} exists: ${ref}`,
        });
      } catch {
        results.push({
          id: `ref:${ref}`,
          description: `Referenced file exists: ${ref}`,
          severity: "pass",
          message: `Referenced path exists: ${ref}`,
        });
      }
    } else {
      results.push({
        id: `ref:${ref}`,
        description: `Referenced file exists: ${ref}`,
        severity: "error",
        message: `Referenced file not found: ${ref}`,
        details: `Expected at: ${absPath}`,
      });
    }
  }

  return results;
}

function buildReport(
  skillName: string | null,
  results: CheckResult[],
): PackageReport {
  return {
    skill_name: skillName,
    timestamp: new Date().toISOString(),
    results,
    summary: summarize(results),
  };
}
