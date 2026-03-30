import type { SkillFrontmatter } from "../schemas/skill-frontmatter.js";
import type { SiblingSkill } from "../schemas/eval-spec.js";

/**
 * A skill entry in the available-skills roster.
 */
export interface RosterEntry {
  name: string;
  description: string;
  isTarget: boolean;
}

/**
 * The complete roster presented to the trigger evaluator.
 */
export interface SkillRoster {
  target: RosterEntry;
  siblings: RosterEntry[];
  all: RosterEntry[];
}

/**
 * Build an available-skills roster from a target skill and optional siblings.
 *
 * The roster is the simulated list of skills available for selection,
 * used by the trigger runner to determine which skill would activate.
 */
export function buildRoster(
  targetFrontmatter: SkillFrontmatter,
  siblings?: SiblingSkill[],
): SkillRoster {
  const target: RosterEntry = {
    name: targetFrontmatter.name,
    description: targetFrontmatter.description,
    isTarget: true,
  };

  const siblingEntries: RosterEntry[] = (siblings ?? []).map((s) => ({
    name: s.name,
    description: s.description,
    isTarget: false,
  }));

  return {
    target,
    siblings: siblingEntries,
    all: [target, ...siblingEntries],
  };
}

/**
 * Format a roster into a text representation for prompt injection.
 */
export function formatRoster(roster: SkillRoster): string {
  const lines = roster.all.map(
    (entry) => `- **${entry.name}**: ${entry.description}`,
  );
  return `Available skills:\n${lines.join("\n")}`;
}
