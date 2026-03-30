import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseAndValidateYaml,
  EvalSpecSchema,
  EvalContractSchema,
  parseSkillMd,
  parseSkillMdEnterprise,
  type EvalSpec,
  type EvalContract,
  type ParsedSkill,
  type SkillFrontmatter,
} from "@j-rig/core";

/**
 * Loads and validates an eval spec YAML file.
 *
 * Resolution order:
 * 1. `specPath` — used verbatim when provided.
 * 2. `skillDir` — searches for `eval-spec.yaml` then `eval-spec.yml`.
 *
 * Throws with a descriptive message on missing file or schema violation.
 */
export function loadEvalSpec(specPath?: string, skillDir?: string): EvalSpec {
  let filePath: string;

  if (specPath) {
    filePath = resolve(specPath);
  } else if (skillDir) {
    const candidates = ["eval-spec.yaml", "eval-spec.yml"];
    const found = candidates
      .map((c) => join(resolve(skillDir), c))
      .find(existsSync);
    if (!found) {
      throw new Error(
        `No eval spec found. Tried: ${candidates.join(", ")} in ${skillDir}. Use --spec to provide a path.`,
      );
    }
    filePath = found;
  } else {
    throw new Error("Either specPath or skillDir must be provided");
  }

  const content = readFileSync(filePath, "utf-8");
  const result = parseAndValidateYaml(content, EvalSpecSchema);
  if (!result.success) {
    const msgs = result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid eval spec:\n${msgs}`);
  }
  return result.data;
}

/**
 * Loads and validates an eval contract YAML file at the given path.
 *
 * Throws with a descriptive message on missing file or schema violation.
 */
export function loadEvalContract(contractPath: string): EvalContract {
  const content = readFileSync(resolve(contractPath), "utf-8");
  const result = parseAndValidateYaml(content, EvalContractSchema);
  if (!result.success) {
    const msgs = result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid eval contract:\n${msgs}`);
  }
  return result.data;
}

/**
 * Loads and validates a SKILL.md file from the given directory.
 *
 * @param skillDir - Directory that contains `SKILL.md`.
 * @param enterprise - When `true`, validates against the enterprise-tier
 *   schema (requires `author`, `version`, `license`, `allowed-tools`).
 *   Defaults to `false` (standard tier).
 *
 * Returns both the structured `ParsedSkill` and the raw file content so
 * callers that need the original markdown body have it without re-reading.
 *
 * Throws with a descriptive message when the file is missing or fails
 * schema validation.
 */
export function loadSkillMd(
  skillDir: string,
  enterprise = false,
): { parsed: ParsedSkill<SkillFrontmatter>; raw: string } {
  const absDir = resolve(skillDir);
  const skillPath = join(absDir, "SKILL.md");

  if (!existsSync(skillPath)) {
    throw new Error(`SKILL.md not found at: ${skillPath}`);
  }

  const raw = readFileSync(skillPath, "utf-8");
  const parser = enterprise ? parseSkillMdEnterprise : parseSkillMd;
  const result = parser(raw);

  if (!result.success) {
    const msgs = result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    throw new Error(`SKILL.md parse error:\n${msgs}`);
  }

  // Enterprise frontmatter is structurally a superset of standard frontmatter,
  // so the cast is safe — all required standard fields are present.
  return { parsed: result.data as ParsedSkill<SkillFrontmatter>, raw };
}

// Re-export types so command files can import from a single location.
export type { ParsedSkill, EvalSpec, EvalContract };
