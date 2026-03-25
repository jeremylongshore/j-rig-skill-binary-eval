<!-- PROVENANCE: Extracted from ~/.claude/skills/validate-skillmd/SKILL.md on 2026-03-24.
     100-point enterprise rubric used by /validate-skillmd for marketplace grading. -->

# Validate-SkillMD 100-Point Rubric

Source: `/validate-skillmd` SKILL.md v2.0.0

## Rubric Pillars

| Pillar | Max Points | What It Measures |
|--------|-----------|-----------------|
| Progressive Disclosure | 30 | Token economy, layered structure, navigation |
| Ease of Use | 25 | Metadata, discoverability, workflow clarity |
| Utility | 20 | Problem solving, examples, feedback loops |
| Spec Compliance | 15 | Frontmatter, naming, description quality |
| Writing Style | 10 | Voice, objectivity, conciseness |
| Modifiers | +/- variable | Bonuses and penalties |

**Total: 100 points base + modifiers**

## Grade Scale

| Grade | Score Range |
|-------|------------|
| A | 90+ |
| B | 80–89 |
| C | 70–79 |
| D | 60–69 |
| F | < 60 |

## Two-Tier System

### Standard Tier (default)
- No required fields
- Broad compatibility
- Warnings only (no failures)

### Enterprise Tier (`--enterprise`)
- Full 100-point rubric applied
- `ALWAYS_REQUIRED` fields enforced: name, description, allowed-tools, version, author, license, compatible-with, tags
- Strict marketplace grading
- Grade gates supported (`--min-grade B`)

## High-Value Fix Recommendations

Common fixes sorted by point value:

| Fix | Points |
|-----|--------|
| Extract long content to references/ | up to +10 (token_economy) |
| Add Overview section | +4 |
| Add "Use when" to description | +3 |
| Add "Trigger with" to description | +3 |
| Add Prerequisites section | +2 |
| Add Output section | +2 |
| Add Error Handling section | +2 |
| Move author/version from nested metadata to top-level | +2 |
| Add external resource links | +1 (modifier) |
| Add DCI directives for discovery | +1 (modifier) |

## v5.0 Validator Features

- **Stub detection**: `is_stub` flag for placeholder skills
- **Content density scoring**: Word count, code blocks, placeholder density
- **Agent compliance**: Anthropic 14-field spec validation
- **Plugin-as-unit roll-up**: Aggregate scores across skills in a plugin
- **Structural advisors** (INFO-level):
  - **Split to commands**: 3+ kebab-case `## operation-name` sections → suggest `commands/` split
  - **Offload to references**: Body sections >20 lines → suggest `references/` extraction
  - **DCI opportunities**: File existence checks, git operations, tool version detection without DCI

## Auto-Fix Sequence

When grade < B (80), auto-fix applies in order:

1. Add missing sections (Overview, Prerequisites, Output, Error Handling, Examples)
2. Add "Use when" / "Trigger with" to description if missing
3. Move author/version/license from nested metadata to top-level
4. Fix text references to use relative markdown links
5. Split long SKILL.md (>500 lines) into references/ with relative links
6. Scope unscoped Bash tools: `Bash` → `Bash(command:*)`
7. Add DCI directives for common discovery patterns
8. If 3+ operation sections found, offer to split into `commands/*.md` files

After fixes, re-run validator and show before/after comparison.

## Validator Invocation

```bash
# Standard tier
python3 ~/000-projects/claude-code-plugins/scripts/validate-skills-schema.py <path>

# Enterprise tier (full 100-point rubric)
python3 ~/000-projects/claude-code-plugins/scripts/validate-skills-schema.py --enterprise <path>

# Enterprise + write to compliance DB
python3 ~/000-projects/claude-code-plugins/scripts/validate-skills-schema.py --enterprise --populate-db ~/000-projects/claude-code-plugins/freshie/inventory.sqlite <path>

# Show D/F grade skills
python3 ~/000-projects/claude-code-plugins/scripts/validate-skills-schema.py --enterprise --show-low-grades

# Minimum grade gate (exits 1 if below threshold)
python3 ~/000-projects/claude-code-plugins/scripts/validate-skills-schema.py --enterprise --min-grade B <path>
```
