# Templates Library

Templates that J-Rig Binary Eval consumes, produces, or evaluates against.

## Authority Tiers

| Tier | Source | Treatment |
|------|--------|-----------|
| **Tier 1** | skill-creator (`~/.claude/skills/skill-creator/`) | Verbatim copy, no validation needed — IS the truth |
| **Tier 2** | nixtla/claude-code-plugins 6767 series | Copied with provenance header, reconciled against official sources |
| **Tier 3** | Authored fresh | Written from current official sources |

---

## skill-templates/ — What J-Rig Evaluates

SKILL.md structural patterns. Source: skill-creator (Tier 1).

| File | Description | Lines |
|------|-------------|-------|
| `skill-template.md` | Full enterprise template with all sections | ~106 |
| `reference-heavy-template.md` | Progressive disclosure pattern — metadata → body → references | ~62 |
| `doc-workflow-template.md` | Workflow-style skill (multi-step processes) | ~62 |
| `file-processor-template.md` | Artifact-producing skill (reads input → writes output) | ~57 |
| `creative-output-template.md` | Creative output skill (content generation) | ~51 |
| `minimal-template.md` | Anthropic official minimal SKILL.md | ~10 |

## eval-schemas/ — Eval JSON Schemas

JSON schemas that J-Rig consumes and produces. Source: skill-creator (Tier 1).

| File | Description | Lines |
|------|-------------|-------|
| `schemas.md` | evals.json, history.json, grading.json, comparison.json schemas | ~430 |

## dev-planning/ — Dev Planning Templates

Planning document templates for J-Rig's own docs. Source: nixtla (Tier 2 — verbatim, no reconciliation needed for templates).

| File | Description | Lines |
|------|-------------|-------|
| `01-BUSINESS-CASE-TEMPLATE.md` | Business case template | ~78 |
| `02-PRD-TEMPLATE.md` | Product requirements document | ~96 |
| `03-ARCHITECTURE-TEMPLATE.md` | Architecture decision record | ~131 |
| `04-USER-JOURNEY-TEMPLATE.md` | User journey mapping | ~157 |
| `05-TECHNICAL-SPEC-TEMPLATE.md` | Technical specification | ~213 |
| `06-STATUS-TEMPLATE.md` | Status report template | ~92 |
