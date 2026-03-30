import { z } from "zod";

/**
 * Model values for SKILL.md frontmatter.
 */
export const SkillModel = z.enum(["inherit", "sonnet", "haiku", "opus"]);

/**
 * Effort levels for SKILL.md frontmatter.
 */
export const SkillEffort = z.enum(["low", "medium", "high", "max"]);

/**
 * Kebab-case name pattern used for skill names.
 */
const KEBAB_CASE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * Anti-patterns for skill descriptions (first/second person).
 */
const DESCRIPTION_ANTI_PATTERNS = [
  /\b(I can|I will|I'm|I help)\b/i,
  /\b(You can|You should|You will)\b/i,
];

/**
 * XML tag pattern — prohibited in name and description fields (Anthropic best practices 2026).
 */
const XML_TAG_PATTERN = /[<>]/;

/**
 * SKILL.md frontmatter schema — standard tier.
 * Required fields: name, description.
 * Optional fields: everything else.
 */
export const SkillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(KEBAB_CASE, "Must be kebab-case (e.g. 'my-skill-name')")
      .refine(
        (name) => !XML_TAG_PATTERN.test(name),
        "Name must not contain XML tags (< or >)",
      ),
    description: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (desc) => !DESCRIPTION_ANTI_PATTERNS.some((p) => p.test(desc)),
        "Description must use third person — avoid 'I can', 'You should', etc.",
      )
      .refine(
        (desc) => !XML_TAG_PATTERN.test(desc),
        "Description must not contain XML tags (< or >)",
      ),
    author: z.string().optional(),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "Must be semver (X.Y.Z)")
      .optional(),
    license: z.string().optional(),
    "allowed-tools": z.string().optional(),
    compatibility: z.string().max(500).optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    model: z.union([SkillModel, z.string()]).optional(),
    effort: SkillEffort.optional(),
    "argument-hint": z.string().optional(),
    "disable-model-invocation": z.boolean().optional(),
    "user-invocable": z.boolean().optional(),
    context: z.literal("fork").optional(),
    agent: z.string().optional(),
    "compatible-with": z.string().optional(),
    hooks: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/**
 * Enterprise tier — adds required fields beyond standard.
 */
export const SkillFrontmatterEnterpriseSchema = SkillFrontmatterSchema.extend({
  author: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Must be semver (X.Y.Z)"),
  license: z.string().min(1),
  "allowed-tools": z.string().min(1),
});

export type SkillFrontmatterEnterprise = z.infer<typeof SkillFrontmatterEnterpriseSchema>;
