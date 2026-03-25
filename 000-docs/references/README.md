# References Library

Reference standards, evaluation patterns, agent definitions, and enterprise standards that J-Rig Binary Eval evaluates against.

## Authority Hierarchy

1. **AgentSkills.io spec** (`agentskills.io/specification`) — THE official standard
2. **skill-creator references** (`~/.claude/skills/skill-creator/`) — Anthropic-aligned, actively maintained
3. **validate-skills-schema.py v5.0** — Production validator, schema registry synced 2026-03-21

---

## skill-standards/ — What J-Rig Evaluates Against

| File | Tier | Description |
|------|------|-------------|
| `agentskills-io-spec.md` | **0** | Official AgentSkills.io spec with all hard limits (extracted 2026-03-24) |
| `source-of-truth.md` | 1 | Canonical skill standards from skill-creator |
| `frontmatter-spec.md` | 1 | Complete SKILL.md field specification |
| `validation-rules.md` | 1 | Two-tier validation (Standard + Enterprise) |

## eval-patterns/ — How J-Rig Evaluates

| File | Tier | Description |
|------|------|-------------|
| `advanced-eval-workflow.md` | 1 | Eval methodology: spawn, grade, compare, iterate |
| `workflows.md` | 1 | Workflow patterns skills use |
| `output-patterns.md` | 1 | Output patterns skills produce |

## agents/ — Judge/Grading Agent Patterns

| File | Tier | Description |
|------|------|-------------|
| `grader.md` | 1 | External grader — binary pass/fail with evidence |
| `comparator.md` | 1 | Blind A/B comparison |
| `analyzer.md` | 1 | Post-hoc analysis |

## enterprise-standards/ — Enterprise Grading & Plugin Standards

| File | Tier | Description |
|------|------|-------------|
| `validate-skillmd-rubric.md` | 3 | 100-point rubric extracted from validate-skillmd |
| `validate-skills-schema-registry.md` | 0 | Production validator schema registry (v5.0) |

## drift-and-consistency/ — Drift Operations (Epic 10)

| File | Tier | Description |
|------|------|-------------|
| `drift-categories.md` | 1 | Drift category taxonomy |
| `source-of-truth-hierarchy.md` | 1 | Authority hierarchy for conflict resolution |

## epic-workflows/ — ASCII Workflow Diagrams

| File | Description |
|------|-------------|
| `epic-01-workflow.md` | Repo Foundation & Operating Standard |
| `epic-02-workflow.md` | Spec Layer & Contract System |
| `epic-03-workflow.md` | Package Integrity & Deterministic Checks |
| `epic-04-workflow.md` | Evidence Layer, Persistence & Run Lifecycle |
| `epic-05-workflow.md` | Trigger Harness & Skill Roster Simulation |
| `epic-06-workflow.md` | Functional Execution Harness & Observation Layer |
| `epic-07-workflow.md` | Judgment Layer, Calibration & Model Matrix |
| `epic-08-workflow.md` | Regression Baseline, Scoring CLI & CI Gate |
| `epic-09-workflow.md` | Optimizer & Experiment Engine |
| `epic-10-workflow.md` | Team/Product Eval Packs & Drift Operations |
