/**
 * Kernel shadow-equivalence test for skill-frontmatter [9k5h.15].
 *
 * Mirrors the evidence-bundle.kernel-shadow.test.ts D1-D7 pattern. Post-cutover,
 * j-rig's ENTERPRISE schema IS the kernel's full composed SkillFrontmatterSchema
 * (base ∧ universal folds ∧ IS overlay) with ONE additive eval-domain layer on
 * top (the third-person description heuristic); the STANDARD schema wraps the
 * kernel base composition (upstream-base ∧ universal folds). This test proves:
 *
 *   S1. The 8-field required set is identical in both (and matches the
 *       NON-NEGOTIABLE IS marketplace literal).
 *   S2. Name pattern + name length ceiling agree (constants + behavior).
 *   S3. Description cap agrees (kernel disclosureMarkers fold, 1536).
 *   S4. The canonical valid 8-field artifact is accepted by BOTH.
 *   S5. Removing EACH required field rejects in BOTH.
 *   S6. The retained local refinement is ADDITIVE:
 *       (a) a kernel-valid input that the eval-domain layer rejects is ALLOWED
 *           (kernel accepts, j-rig rejects — that is the layer working), and
 *       (b) a j-rig-valid input that the kernel rejects must NOT exist —
 *           proven over the full fixture battery: jrig.success ⇒ kernel.success.
 *
 * Note on tier scope: the STANDARD tier intentionally accepts artifacts the
 * full kernel composition rejects (it wraps only the BASE composition — the
 * overlay's 6 extra required fields are an enterprise concern), so the S6(b)
 * property is asserted against the ENTERPRISE schema, which claims kernel
 * marketplace-tier equivalence.
 */
import { describe, it, expect } from "vitest";

// j-rig's schemas (kernel primary + j-rig eval-domain superRefine).
import {
  SkillFrontmatterSchema as JRigStandardSchema,
  SkillFrontmatterEnterpriseSchema as JRigEnterpriseSchema,
  SKILL_FRONTMATTER_REQUIRED_FIELDS as JRIG_REQUIRED_FIELDS,
  SKILL_NAME_PATTERN as JRIG_NAME_PATTERN,
  SKILL_NAME_MAX as JRIG_NAME_MAX,
  SKILL_DESCRIPTION_MAX as JRIG_DESCRIPTION_MAX,
} from "./skill-frontmatter.js";

// The kernel-canonical surface (primary enforcement).
import {
  SkillFrontmatterSchema as KernelSchema,
  SKILL_FRONTMATTER_REQUIRED_FIELDS as KERNEL_REQUIRED_FIELDS,
  SKILL_NAME_PATTERN as KERNEL_NAME_PATTERN,
  SKILL_NAME_MAX as KERNEL_NAME_MAX,
  SKILL_DESCRIPTION_MAX as KERNEL_DESCRIPTION_MAX,
} from "@intentsolutions/core/validators/v1/authoring";

// ── Shared structural fixtures ──────────────────────────────────────────────

/** Canonical valid 8-field IS marketplace artifact. Both schemas must accept. */
function validFrontmatter(): Record<string, unknown> {
  return {
    name: "commit-message-writer",
    description:
      "Generates conventional commit messages from staged git diffs and produces type(scope) subject output.",
    "allowed-tools": "Bash(git:diff --staged)",
    version: "1.0.0",
    author: "Intent Solutions",
    license: "Apache-2.0",
    compatibility: "Designed for Claude Code 2.x",
    tags: ["git", "developer-tools"],
  };
}

/** Mutations that the KERNEL rejects — used for S2/S3/S5 and the S6(b) battery. */
function kernelInvalidVariants(): Array<[string, Record<string, unknown>]> {
  const variants: Array<[string, Record<string, unknown>]> = [];
  for (const field of KERNEL_REQUIRED_FIELDS) {
    const artifact = validFrontmatter();
    delete artifact[field];
    variants.push([`missing required field "${field}"`, artifact]);
  }
  variants.push(
    ["non-kebab-case name", { ...validFrontmatter(), name: "BAD_NAME_123!" }],
    [
      "name over the 64-char ceiling",
      { ...validFrontmatter(), name: "a".repeat(KERNEL_NAME_MAX + 1) },
    ],
    [
      "description over the 1536-char cap",
      { ...validFrontmatter(), description: "d".repeat(KERNEL_DESCRIPTION_MAX + 1) },
    ],
    ["XML angle brackets in name", { ...validFrontmatter(), name: "bad<name>" }],
    [
      "XML tags in description",
      { ...validFrontmatter(), description: "Does <thing> for the user." },
    ],
    ["reserved-word name", { ...validFrontmatter(), name: "skill" }],
    [
      "deprecated compatible-with field",
      { ...validFrontmatter(), "compatible-with": "Claude Code" },
    ],
    ["non-semver version", { ...validFrontmatter(), version: "1.0" }],
    ["non-array tags", { ...validFrontmatter(), tags: "git" }],
  );
  return variants;
}

describe("kernel shadow-equivalence: 8-field required set (S1)", () => {
  it("S1 — j-rig re-exports the kernel's required-field set unchanged", () => {
    expect(JRIG_REQUIRED_FIELDS).toEqual(KERNEL_REQUIRED_FIELDS);
  });

  it("S1 — the set is the NON-NEGOTIABLE IS 8-field marketplace literal", () => {
    expect([...JRIG_REQUIRED_FIELDS]).toEqual([
      "name",
      "description",
      "allowed-tools",
      "version",
      "author",
      "license",
      "compatibility",
      "tags",
    ]);
  });
});

describe("kernel shadow-equivalence: name pattern + max (S2)", () => {
  it("S2 — name pattern and length ceiling constants are identical", () => {
    expect(JRIG_NAME_PATTERN.source).toBe(KERNEL_NAME_PATTERN.source);
    expect(JRIG_NAME_MAX).toBe(KERNEL_NAME_MAX);
    expect(JRIG_NAME_MAX).toBe(64);
  });

  it("S2 — both reject a non-kebab-case name and an over-length name", () => {
    for (const name of ["BAD_NAME_123!", "a".repeat(65)]) {
      const artifact = { ...validFrontmatter(), name };
      expect(JRigEnterpriseSchema.safeParse(artifact).success).toBe(false);
      expect(KernelSchema.safeParse(artifact).success).toBe(false);
    }
  });
});

describe("kernel shadow-equivalence: description cap (S3)", () => {
  it("S3 — both use the kernel disclosureMarkers 1536-char cap", () => {
    expect(JRIG_DESCRIPTION_MAX).toBe(KERNEL_DESCRIPTION_MAX);
    expect(JRIG_DESCRIPTION_MAX).toBe(1536);

    const atCap = { ...validFrontmatter(), description: "d".repeat(1536) };
    expect(JRigEnterpriseSchema.safeParse(atCap).success).toBe(true);
    expect(KernelSchema.safeParse(atCap).success).toBe(true);

    const overCap = { ...validFrontmatter(), description: "d".repeat(1537) };
    expect(JRigEnterpriseSchema.safeParse(overCap).success).toBe(false);
    expect(KernelSchema.safeParse(overCap).success).toBe(false);
  });
});

describe("kernel shadow-equivalence: canonical valid artifact accepts (S4)", () => {
  it("j-rig enterprise schema accepts the canonical 8-field artifact", () => {
    expect(JRigEnterpriseSchema.safeParse(validFrontmatter()).success).toBe(true);
  });

  it("kernel schema accepts the canonical 8-field artifact", () => {
    expect(KernelSchema.safeParse(validFrontmatter()).success).toBe(true);
  });

  it("j-rig standard schema accepts the canonical artifact AND the base-only floor", () => {
    expect(JRigStandardSchema.safeParse(validFrontmatter()).success).toBe(true);
    // The standard tier wraps the kernel BASE composition: name + description
    // only — overlay fields are an enterprise concern by design.
    const baseOnly = {
      name: "commit-message-writer",
      description: "Generates conventional commit messages from staged git diffs.",
    };
    expect(JRigStandardSchema.safeParse(baseOnly).success).toBe(true);
    expect(KernelSchema.safeParse(baseOnly).success).toBe(false);
  });
});

describe("kernel shadow-equivalence: each missing required field rejects (S5)", () => {
  for (const field of KERNEL_REQUIRED_FIELDS) {
    it(`both reject when "${field}" is missing`, () => {
      const artifact = validFrontmatter();
      delete artifact[field];
      expect(JRigEnterpriseSchema.safeParse(artifact).success).toBe(false);
      expect(KernelSchema.safeParse(artifact).success).toBe(false);
    });
  }

  it("the standard tier still requires the base floor (name, description)", () => {
    for (const field of ["name", "description"]) {
      const artifact = validFrontmatter();
      delete artifact[field];
      expect(JRigStandardSchema.safeParse(artifact).success).toBe(false);
    }
  });
});

describe("kernel shadow-equivalence: eval-domain layer is ADDITIVE (S6)", () => {
  it("S6a — a kernel-valid first-person description is rejected ONLY by j-rig (allowed)", () => {
    const firstPerson = {
      ...validFrontmatter(),
      description: "I can help you write conventional commit messages.",
    };
    // The kernel does not encode the third-person heuristic — it accepts.
    expect(KernelSchema.safeParse(firstPerson).success).toBe(true);
    // j-rig's eval-domain layer rejects on top — additive tightening is allowed.
    const jrig = JRigEnterpriseSchema.safeParse(firstPerson);
    expect(jrig.success).toBe(false);
    if (!jrig.success) {
      expect(jrig.error.issues.some((i) => i.message.includes("third person"))).toBe(true);
    }
    // Same layering on the standard tier.
    expect(JRigStandardSchema.safeParse(firstPerson).success).toBe(false);
  });

  it("S6b — no j-rig-enterprise-valid input that the kernel rejects exists (battery)", () => {
    const battery: Array<[string, Record<string, unknown>]> = [
      ["canonical valid artifact", validFrontmatter()],
      ...kernelInvalidVariants(),
      [
        "first-person description",
        { ...validFrontmatter(), description: "I can help you do things." },
      ],
      [
        "second-person description",
        { ...validFrontmatter(), description: "You should use this for commits." },
      ],
    ];
    for (const [label, artifact] of battery) {
      const jrig = JRigEnterpriseSchema.safeParse(artifact).success;
      const kernel = KernelSchema.safeParse(artifact).success;
      // jrig.success ⇒ kernel.success: the local layer may only tighten.
      expect(
        !jrig || kernel,
        `additivity violated for "${label}": j-rig accepted what the kernel rejects`,
      ).toBe(true);
    }
  });

  it("S6b — every kernel-rejected variant is also rejected by j-rig enterprise", () => {
    for (const [label, artifact] of kernelInvalidVariants()) {
      expect(
        JRigEnterpriseSchema.safeParse(artifact).success,
        `j-rig enterprise must reject: ${label}`,
      ).toBe(false);
    }
  });
});
