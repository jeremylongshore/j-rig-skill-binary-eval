/**
 * SKILL.md frontmatter schemas — kernel authoring cutover [9k5h.15].
 *
 * The kernel `@intentsolutions/core` `schemas/authoring/v1` composition is the
 * single source of truth for skill-frontmatter validity (SAK SSoT; DR-044 D7).
 * This file RE-EXPORTS the kernel composition as j-rig's public surface and no
 * longer hand-rolls any field rule the kernel already owns:
 *
 *   STANDARD tier   = the kernel BASE composition
 *                     (upstream-base projection ∧ the three universal folds)
 *   ENTERPRISE tier = the kernel's full composed `SkillFrontmatterSchema`
 *                     (base ∧ universal folds ∧ IS overlay = the 8-field IS
 *                     marketplace set: name, description, allowed-tools,
 *                     version, author, license, compatibility, tags)
 *
 * The ONLY retained local rule is the third-person description heuristic —
 * j-rig EVAL-DOMAIN logic that is NOT part of the kernel composition. It is
 * layered ON TOP as a `.superRefine`, mirroring how evidence-bundle.ts layers
 * its secondary checks on the kernel's EvidenceStatementSchema. The layer is
 * strictly ADDITIVE: it can only reject kernel-valid inputs, never accept
 * kernel-invalid ones. The kernel-shadow test
 * (`skill-frontmatter.kernel-shadow.test.ts`) proves this property.
 *
 * Deleted in this cutover (now duplicated by the kernel):
 *   - local kebab-case name pattern + 64-char ceiling  → kernel upstream-base
 *   - local XML-tag checks on name/description         → kernel securityChecks fold
 *   - local description length cap                     → kernel disclosureMarkers fold (1536)
 *   - local semver / compatibility / tags field rules  → kernel is-overlay
 *   - local optional acceptance of `compatible-with`   → kernel deprecationRegistry fold
 */
import { z } from "zod";

// ── Kernel imports (primary schema authority) ──────────────────────────────
// Barrel surface: the full composed schema + the contract constants.
export {
  SkillFrontmatterSchema as KernelSkillFrontmatterSchema,
  skillFrontmatterIssues,
  SKILL_FRONTMATTER_BASE_REQUIRED,
  SKILL_FRONTMATTER_OVERLAY_REQUIRED,
  SKILL_FRONTMATTER_REQUIRED_FIELDS,
  SKILL_NAME_PATTERN,
  SKILL_NAME_MAX,
  SKILL_COMPATIBILITY_MAX,
  SKILL_DESCRIPTION_MAX,
} from "@intentsolutions/core/validators/v1/authoring";

import {
  SkillFrontmatterSchema as KernelSkillFrontmatterSchemaInternal,
  attach,
  universalFoldsIssues,
  type AuthoringArtifact,
  type FoldIssue,
} from "@intentsolutions/core/validators/v1/authoring";

// Per-layer fold functions are intentionally NOT on the barrel (every contract
// exports the same layer names); the deep subpath is sanctioned by the kernel's
// `./validators/v1/*` exports wildcard.
import { upstreamBaseIssues } from "@intentsolutions/core/validators/v1/authoring/skill-frontmatter";

// ── Legacy value enums (public API helpers, retained) ──────────────────────
// These are NOT validation rules: the kernel composition is open-world on the
// Claude-platform `model` / `effort` extension fields. Retained as exported
// value enums because they are part of j-rig's public surface via index.ts.

/** Model values for SKILL.md frontmatter. */
export const SkillModel = z.enum(["inherit", "sonnet", "haiku", "opus"]);

/** Effort levels for SKILL.md frontmatter. */
export const SkillEffort = z.enum(["low", "medium", "high", "max"]);

// ── Typed views (convenience interfaces over the kernel's open-world type) ──

/**
 * Standard-tier frontmatter. The kernel base composition guarantees `name`
 * (kebab-case string ≤ 64) and `description` (string) when parsing succeeds;
 * everything else is open-world per the kernel's `AuthoringArtifact`.
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

/**
 * Enterprise-tier frontmatter — the IS 8-field marketplace set. The kernel's
 * full composition guarantees presence + type of every field below.
 */
export interface SkillFrontmatterEnterprise extends SkillFrontmatter {
  author: string;
  version: string;
  license: string;
  "allowed-tools": string | string[];
  compatibility: string;
  tags: string[];
}

// ── EVAL-DOMAIN layer (j-rig-local, additive — NOT in the kernel) ──────────

/**
 * Anti-patterns for skill descriptions (first/second person).
 * EVAL-DOMAIN heuristic: third-person phrasing is a j-rig skill-quality rule,
 * not an authoring-spec rule — the kernel composition does not (and must not)
 * encode it.
 */
const DESCRIPTION_ANTI_PATTERNS = [
  /\b(I can|I will|I'm|I help)\b/i,
  /\b(You can|You should|You will)\b/i,
];

/**
 * Pure eval-domain checker, kernel fold style. ADDITIVE ONLY: it may reject
 * kernel-valid inputs but can never accept a kernel-invalid one (it is layered
 * on top of, never instead of, the kernel composition).
 */
export function thirdPersonDescriptionIssues(artifact: AuthoringArtifact): FoldIssue[] {
  const description = artifact["description"];
  if (typeof description !== "string") {
    return [];
  }
  if (DESCRIPTION_ANTI_PATTERNS.some((p) => p.test(description))) {
    return [
      {
        message: "Description must use third person — avoid 'I can', 'You should', etc.",
        path: ["description"],
      },
    ];
  }
  return [];
}

/** Layer the eval-domain checks on a kernel schema (evidence-bundle.ts pattern). */
function withEvalDomainChecks(schema: z.ZodType<AuthoringArtifact>): z.ZodType<AuthoringArtifact> {
  return schema.superRefine((artifact, ctx) => {
    // j-rig EVAL-DOMAIN secondary check — additive on top of the kernel.
    for (const issue of thirdPersonDescriptionIssues(artifact)) {
      ctx.addIssue({ code: "custom", message: issue.message, path: [...issue.path] });
    }
  });
}

// ── Tier schemas (kernel primary + eval-domain layer) ──────────────────────

/** The kernel BASE composition: upstream-base ∧ the three universal folds. */
function kernelBaseCompositionIssues(artifact: AuthoringArtifact): FoldIssue[] {
  return [...upstreamBaseIssues(artifact), ...universalFoldsIssues(artifact)];
}

/**
 * SKILL.md frontmatter schema — standard tier.
 * Wraps the kernel base composition (required: name, description) plus the
 * j-rig eval-domain layer. The trailing `.pipe(z.custom<...>())` is a
 * type-narrowing no-op: the kernel base layer guarantees the narrowed fields.
 */
export const SkillFrontmatterSchema = withEvalDomainChecks(
  attach(kernelBaseCompositionIssues),
).pipe(z.custom<SkillFrontmatter>());

/**
 * Enterprise tier — the kernel's full composed SkillFrontmatterSchema
 * (the 8-field IS marketplace set) plus the j-rig eval-domain layer.
 */
export const SkillFrontmatterEnterpriseSchema = withEvalDomainChecks(
  KernelSkillFrontmatterSchemaInternal,
).pipe(z.custom<SkillFrontmatterEnterprise>());
