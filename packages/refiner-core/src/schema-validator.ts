/**
 * SchemaValidator — injectable seam for SKILL.md frontmatter schema-validity.
 *
 * The 4-quadrant decision matrix (decide.ts) needs to know whether the
 * applied SKILL.md is schema-valid BEFORE calling the existing accept() gate.
 * Schema-validity is the second axis of the matrix.
 *
 * This file defines a lean `SchemaValidator` interface so the matrix stays
 * pure/deterministic and independently unit-testable with a stub. The
 * concrete implementation below wires the kernel
 * `@intentsolutions/core/validators/v1/authoring` `SkillFrontmatterSchema`
 * (the IS 8-field marketplace tier) — that schema is the SSoT for
 * authoring-artifact validity per DR-044 D7.
 *
 * Callers: `kernelSkillFrontmatterValidator()` builds the concrete validator
 * once (it's stateless, so the instance can be a module-level singleton).
 * Tests supply a `SchemaValidator` stub directly to `decide()`.
 *
 * WHY an interface and not a direct kernel import inside decide.ts?
 * - `decide.ts` is a pure function. Injecting the validator keeps it that way.
 * - Downstream packages may want to compose additional checks (eval-domain
 *   overlay, third-person heuristic) on top of the kernel base tier without
 *   coupling `decide()` to the exact tier they choose.
 * - The interface lets tests stub schema-validity as a single boolean without
 *   having to parse real YAML/JSON frontmatter.
 */

import { SkillFrontmatterSchema } from "@intentsolutions/core/validators/v1/authoring";

// ── Interface ──────────────────────────────────────────────────────────────

/**
 * Outcome of a schema-validity check on a SKILL.md text.
 *
 * `valid: true` — the frontmatter satisfies the kernel IS 8-field
 * marketplace tier (or whatever tier the injected validator implements).
 *
 * `valid: false` — frontmatter is malformed or violates at least one kernel
 * rule; `issues` carries human-readable diagnostics for the
 * schema-revision-candidate record.
 */
export type SchemaValidityResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly string[] };

/**
 * A pure validator for SKILL.md frontmatter. Receives the FULL skill-doc text
 * (frontmatter + body) and returns whether the frontmatter is schema-valid.
 *
 * Implementations MUST be deterministic: the same text always yields the same
 * result. They MUST NOT cause I/O or network calls.
 */
export interface SchemaValidator {
  /**
   * Validate the SKILL.md frontmatter extracted from `skillDocText`.
   *
   * @param skillDocText — the complete text of the applied SKILL.md (including
   *   the `---` delimiters and body). The implementation is responsible for
   *   extracting the frontmatter block before validating.
   */
  validate(skillDocText: string): SchemaValidityResult;
}

// ── Frontmatter extraction ─────────────────────────────────────────────────

/**
 * Extracts the YAML frontmatter block from a SKILL.md text.
 *
 * Returns the raw YAML string (without `---` delimiters) if a frontmatter
 * block is found, or `null` if the text does not start with `---`.
 *
 * SKILL.md frontmatter blocks follow the CommonMark YAML front-matter
 * convention: the file opens with `---`, closes with `---` or `...`, and
 * everything in between is YAML.
 *
 * @internal Exported for unit testing only.
 */
export function extractFrontmatter(skillDocText: string): string | null {
  const text = skillDocText.startsWith("﻿") ? skillDocText.slice(1) : skillDocText;
  if (!text.startsWith("---")) return null;

  const rest = text.slice(3);
  // The closing delimiter is `---` or `...` on its own line.
  const closingIndex = rest.search(/^(---|\.\.\.)\s*$/m);
  if (closingIndex === -1) return null;

  return rest.slice(0, closingIndex).trim();
}

/**
 * Parses a YAML block into a plain `Record<string, unknown>` using only the
 * standard library. We support the SKILL.md frontmatter subset:
 *   - top-level scalar key: value pairs
 *   - lists (`key:\n  - item`)
 *   - inline flow sequences (`key: [a, b]`)
 *
 * We intentionally avoid pulling a full YAML dependency into `refiner-core`
 * (a pure-value package with only `zod` + the kernel as deps). The frontier
 * SKILL.md authoring spec uses only this subset; anything outside is
 * intentionally treated as parse failure.
 *
 * @internal Exported for unit testing only.
 */
export function parseFrontmatterYaml(yamlBlock: string): Record<string, unknown> | null {
  if (!yamlBlock.trim()) return {};

  const result: Record<string, unknown> = {};

  // We parse line-by-line. The parser handles:
  //   key: scalar value
  //   key: [inline, list]
  //   key:          (bare → next indented `- item` lines are the list)
  const lines = yamlBlock.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip blank lines and comments.
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    // Top-level key: value
    const colonPos = trimmed.indexOf(":");
    if (colonPos === -1) {
      // Unparseable — bail.
      return null;
    }

    const key = trimmed.slice(0, colonPos).trim();
    const rawValue = trimmed.slice(colonPos + 1).trim();

    if (rawValue.startsWith("[")) {
      // Inline flow sequence: key: [a, b, c]
      const end = rawValue.indexOf("]");
      if (end === -1) return null;
      const inner = rawValue.slice(1, end);
      result[key] = inner
        .split(",")
        .map((s) => stripYamlQuotes(s.trim()))
        .filter((s) => s.length > 0);
      i++;
      continue;
    }

    if (!rawValue) {
      // Bare key: — collect following `- item` lines.
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const nextTrimmed = next.trim();
        if (nextTrimmed.startsWith("- ")) {
          items.push(stripYamlQuotes(nextTrimmed.slice(2).trim()));
          i++;
        } else if (!nextTrimmed || nextTrimmed.startsWith("#")) {
          i++;
        } else {
          break;
        }
      }
      result[key] = items;
      continue;
    }

    // Scalar value.
    result[key] = stripYamlQuotes(rawValue);
    i++;
  }

  return result;
}

/** Strip surrounding quotes from a YAML scalar string. */
function stripYamlQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ── Concrete kernel validator ──────────────────────────────────────────────

/**
 * Builds a `SchemaValidator` backed by the kernel's full
 * `SkillFrontmatterSchema` (IS 8-field enterprise tier — the same tier the
 * IS marketplace and the CCP validator enforce).
 *
 * The kernel validates against a parsed frontmatter object, so this
 * implementation extracts + parses the YAML block before calling `.safeParse`.
 *
 * Construction is cheap (stateless). Callers may cache the result as a
 * module-level singleton or construct per-call — both are safe.
 */
export function kernelSkillFrontmatterValidator(): SchemaValidator {
  return {
    validate(skillDocText: string): SchemaValidityResult {
      const block = extractFrontmatter(skillDocText);
      if (block === null) {
        return {
          valid: false,
          issues: [
            "SKILL.md does not contain a valid YAML frontmatter block (missing --- delimiters)",
          ],
        };
      }

      const parsed = parseFrontmatterYaml(block);
      if (parsed === null) {
        return {
          valid: false,
          issues: ["SKILL.md frontmatter YAML could not be parsed"],
        };
      }

      const result = SkillFrontmatterSchema.safeParse(parsed);
      if (result.success) {
        return { valid: true };
      }

      // Collect human-readable issue messages.
      const issues: string[] = result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      });
      return { valid: false, issues };
    },
  };
}
