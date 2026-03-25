# Document Index: j-rig-binary-eval

> Release-quality evaluation harness and rollout gate for Claude Skills

**Last Updated:** 2026-03-24

## By Category

### PP — Product & Planning
| # | File | Description |
|---|------|-------------|
| 001 | [001-PP-BCASE-business-case.md](001-PP-BCASE-business-case.md) | Business case |
| 002 | [002-PP-PRD-product-requirements.md](002-PP-PRD-product-requirements.md) | Product requirements |
| 004 | [004-PP-UJRN-user-journey.md](004-PP-UJRN-user-journey.md) | User journey |
| 007 | [007-PP-PLAN-master-build-blueprint.md](007-PP-PLAN-master-build-blueprint.md) | Master build blueprint (canonical) |

### AT — Architecture & Technical
| # | File | Description |
|---|------|-------------|
| 003 | [003-AT-ARCH-architecture.md](003-AT-ARCH-architecture.md) | Architecture |
| 005 | [005-AT-SPEC-technical-spec.md](005-AT-SPEC-technical-spec.md) | Technical spec |

### OD — Operations & Deployment
| # | File | Description |
|---|------|-------------|
| 006 | [006-OD-STAT-status.md](006-OD-STAT-status.md) | Status |

## Chronological Listing

| # | Code | File |
|---|------|------|
| 001 | PP-BCASE | [business-case.md](001-PP-BCASE-business-case.md) |
| 002 | PP-PRD | [product-requirements.md](002-PP-PRD-product-requirements.md) |
| 003 | AT-ARCH | [architecture.md](003-AT-ARCH-architecture.md) |
| 004 | PP-UJRN | [user-journey.md](004-PP-UJRN-user-journey.md) |
| 005 | AT-SPEC | [technical-spec.md](005-AT-SPEC-technical-spec.md) |
| 006 | OD-STAT | [status.md](006-OD-STAT-status.md) |
| 007 | PP-PLAN | [master-build-blueprint.md](007-PP-PLAN-master-build-blueprint.md) |

## Epics

Durable epic reference files in [`epics/`](epics/):

| Epic | File |
|------|------|
| [Epic Index](epics/README.md) | Table of contents and active epic |
| [Epic 01](epics/epic-01-repo-foundation-and-operating-standard.md) | Repo Foundation and Operating Standard |
| [Epic 02](epics/epic-02-spec-layer-and-contract-system.md) | Spec Layer and Contract System |
| [Epic 03](epics/epic-03-package-integrity-and-deterministic-checks.md) | Package Integrity and Deterministic Checks |
| [Epic 04](epics/epic-04-evidence-layer-persistence-and-run-lifecycle.md) | Evidence Layer, Persistence and Run Lifecycle |
| [Epic 05](epics/epic-05-trigger-harness-and-skill-roster-simulation.md) | Trigger Harness and Skill Roster Simulation |
| [Epic 06](epics/epic-06-functional-execution-harness-and-observation-layer.md) | Functional Execution Harness and Observation Layer |
| [Epic 07](epics/epic-07-judgment-layer-calibration-and-model-matrix.md) | Judgment Layer, Calibration and Model Matrix |
| [Epic 08](epics/epic-08-regression-baseline-scoring-cli-and-ci-gate.md) | Regression Baseline, Scoring CLI and CI Gate |
| [Epic 09](epics/epic-09-optimizer-and-experiment-engine.md) | Optimizer and Experiment Engine |
| [Epic 10](epics/epic-10-team-product-eval-packs-and-drift-operations.md) | Team/Product Eval Packs and Drift Operations |

## Templates & References Library

Local, self-contained library of templates, reference standards, agent patterns, and epic workflow diagrams.

### Templates ([`templates/`](templates/))

| Directory | Contents | Source Tier |
|-----------|----------|-------------|
| [`skill-templates/`](templates/skill-templates/) | 6 SKILL.md structural patterns | Tier 1 (skill-creator) |
| [`eval-schemas/`](templates/eval-schemas/) | Eval JSON schemas (evals.json, etc.) | Tier 1 (skill-creator) |
| [`dev-planning/`](templates/dev-planning/) | 6 dev planning templates | Tier 2 (nixtla) |

### References ([`references/`](references/))

| Directory | Contents | Source Tier |
|-----------|----------|-------------|
| [`skill-standards/`](references/skill-standards/) | AgentSkills.io spec, source-of-truth, frontmatter, validation | Tier 0–2 |
| [`eval-patterns/`](references/eval-patterns/) | Eval methodology, workflows, output patterns | Tier 1 |
| [`agents/`](references/agents/) | Grader, comparator, analyzer agent patterns | Tier 1 |
| [`enterprise-standards/`](references/enterprise-standards/) | 100-point rubric, schema registry, 6767 standards | Tier 0–2 |
| [`drift-and-consistency/`](references/drift-and-consistency/) | Drift categories, source-of-truth hierarchy | Tier 1 |
| [`audit-tests/`](references/audit-tests/) | Production eval test case exemplar | Tier 1 |
| [`epic-workflows/`](references/epic-workflows/) | 10 ASCII workflow diagrams | Tier 3 (authored) |

## Summary

- **Total documents:** 7 + 10 epics + templates & references library (~46 files)
- **Categories used:** 3 (PP, AT, OD)
- **Next sequence number:** 008
