/**
 * Spec sources of truth for JRig evaluations.
 *
 * Loads versioned snapshots of the authoritative skill specs from
 * `references/specs/` and exposes them as a structured `SpecAuthority`
 * object. Checks elsewhere in JRig (package-checker, governance, etc.)
 * read from this authority instead of hardcoding rules — keeps the
 * spec-of-record DRY and gives future spec-refresh PRs a single point
 * of update.
 *
 * Snapshots refresh quarterly via PR (see references/specs/README.md).
 * Tier 3A of the consumer-side `/validate-skillmd` skill reads these
 * same snapshot files to keep its own validator aligned with what JRig
 * enforces.
 *
 * @see references/specs/anthropic-skills-spec.md
 * @see references/specs/agentskills-spec.md
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structured view of the spec authority loaded from snapshots.
 */
export interface SpecAuthority {
  /** ID of the loaded Anthropic-spec snapshot (e.g. `2026-05-07-initial`). */
  anthropicSnapshotId: string;
  /** ID of the loaded AgentSkills.io-spec snapshot. */
  agentskillsSnapshotId: string;
  /** The two fields Anthropic's published spec mandates. */
  anthropicRequiredFields: readonly string[];
  /** Optional fields documented at code.claude.com/docs/en/skills. */
  anthropicOptionalFields: readonly string[];
  /** Valid `effort` values per Anthropic spec. */
  validEffortValues: readonly string[];
  /** Substitution variables Claude resolves at activation. */
  substitutionVariables: readonly string[];
  /** Maximum length for the AgentSkills.io `compatibility` field, in chars. */
  agentskillsCompatibilityMaxChars: number;
  /** Combined cap for Anthropic `description` + `when_to_use`. */
  anthropicDescriptionCombinedCap: number;
}

/**
 * Resolve the references/specs/ directory regardless of where this
 * module is imported from. Walks up from the source file until it finds
 * the JRig package root (containing `references/`).
 */
function findReferencesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let cursor = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(cursor, "references", "specs");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    cursor = parent;
  }
  // Fallback to a path relative to the repo root assumption.
  return resolve(here, "..", "..", "..", "..", "references", "specs");
}

/**
 * Pull the snapshot ID from a snapshot file's frontmatter-ish header.
 * Snapshots aren't strict YAML frontmatter — they use `**Snapshot ID**: ...`
 * pattern at the top.
 */
function extractSnapshotId(content: string): string {
  const match = content.match(/\*\*Snapshot ID\*\*:\s*([\w-]+)/);
  return match ? match[1]! : "unknown";
}

/**
 * Hand-coded view of the rules captured in the snapshot files. The
 * snapshots are the source of truth (PR-reviewed). This function
 * embeds the same rules into TypeScript for runtime use; the snapshot
 * refresh PR cadence is responsible for keeping these two surfaces in
 * sync.
 *
 * If you change a rule here without updating the snapshot, the snapshot
 * refresh-check (`scripts/check-spec-sources.mjs`, future PR) will
 * raise a divergence error. For now: any rule update happens here AND
 * in the snapshot file in the same PR.
 */
const ANTHROPIC_REQUIRED_FIELDS = ["name", "description"] as const;

const ANTHROPIC_OPTIONAL_FIELDS = [
  "allowed-tools",
  "model",
  "effort",
  "argument-hint",
  "arguments",
  "paths",
  "context",
  "agent",
  "user-invocable",
  "disable-model-invocation",
  "hooks",
  "shell",
  "when_to_use",
  "metadata",
  "compatibility",
  "license",
] as const;

const VALID_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

const SUBSTITUTION_VARIABLES = [
  "$ARGUMENTS",
  "$0",
  "$1",
  "$2",
  "$3",
  "$4",
  "$5",
  "$6",
  "$7",
  "$8",
  "$9",
  "${CLAUDE_SESSION_ID}",
  "${CLAUDE_SKILL_DIR}",
  "${CLAUDE_PLUGIN_ROOT}",
  "${CLAUDE_PLUGIN_DATA}",
  "${CLAUDE_EFFORT}",
] as const;

const AGENTSKILLS_COMPATIBILITY_MAX_CHARS = 500;
const ANTHROPIC_DESCRIPTION_COMBINED_CAP = 1536;

/**
 * Load the spec authority for use by JRig checks.
 *
 * Returns a frozen `SpecAuthority` with snapshot IDs derived from the
 * actual files (so callers can record which snapshot version a given
 * eval was scored against) and rule constants pulled from the embedded
 * TypeScript copies above.
 */
export function loadSpecAuthority(): SpecAuthority {
  const specsDir = findReferencesDir();
  const anthropicPath = join(specsDir, "anthropic-skills-spec.md");
  const agentskillsPath = join(specsDir, "agentskills-spec.md");

  let anthropicSnapshotId = "missing";
  let agentskillsSnapshotId = "missing";

  if (existsSync(anthropicPath)) {
    anthropicSnapshotId = extractSnapshotId(readFileSync(anthropicPath, "utf-8"));
  }
  if (existsSync(agentskillsPath)) {
    agentskillsSnapshotId = extractSnapshotId(readFileSync(agentskillsPath, "utf-8"));
  }

  return Object.freeze({
    anthropicSnapshotId,
    agentskillsSnapshotId,
    anthropicRequiredFields: ANTHROPIC_REQUIRED_FIELDS,
    anthropicOptionalFields: ANTHROPIC_OPTIONAL_FIELDS,
    validEffortValues: VALID_EFFORT_VALUES,
    substitutionVariables: SUBSTITUTION_VARIABLES,
    agentskillsCompatibilityMaxChars: AGENTSKILLS_COMPATIBILITY_MAX_CHARS,
    anthropicDescriptionCombinedCap: ANTHROPIC_DESCRIPTION_COMBINED_CAP,
  });
}

/**
 * Convenience: check a field name against the spec authority.
 *
 * Returns `"required"`, `"optional"`, or `"unknown"` so callers can
 * tag warnings / errors appropriately. `"unknown"` is not the same as
 * "invalid" — Anthropic's spec is permissive and downstream rubrics
 * (like Intent Solutions enterprise) layer on top.
 */
export function classifyField(
  field: string,
  authority: SpecAuthority = loadSpecAuthority(),
): "required" | "optional" | "unknown" {
  if (authority.anthropicRequiredFields.includes(field)) return "required";
  if (authority.anthropicOptionalFields.includes(field)) return "optional";
  return "unknown";
}

/**
 * Convenience: validate an `effort` value against the spec authority.
 */
export function isValidEffort(
  value: string,
  authority: SpecAuthority = loadSpecAuthority(),
): boolean {
  return (authority.validEffortValues as readonly string[]).includes(value);
}
