# Document Index: j-rig-binary-eval

> Release-quality evaluation harness and rollout gate for Claude Skills

**Last Updated:** 2026-06-21

## By Category

### PP — Product & Planning

| #   | File                                                                           | Description                        |
| --- | ------------------------------------------------------------------------------ | ---------------------------------- |
| 001 | [001-PP-BCASE-business-case.md](001-PP-BCASE-business-case.md)                 | Business case                      |
| 002 | [002-PP-PRD-product-requirements.md](002-PP-PRD-product-requirements.md)       | Product requirements               |
| 004 | [004-PP-UJRN-user-journey.md](004-PP-UJRN-user-journey.md)                     | User journey                       |
| 007 | [007-PP-PLAN-master-build-blueprint.md](007-PP-PLAN-master-build-blueprint.md) | Master build blueprint (canonical) |

### AT — Architecture & Technical

| #   | File                                                                                                                     | Description                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 003 | [003-AT-ARCH-architecture.md](003-AT-ARCH-architecture.md)                                                               | Architecture                                                                     |
| 005 | [005-AT-SPEC-technical-spec.md](005-AT-SPEC-technical-spec.md)                                                           | Technical spec                                                                   |
| 010 | [010-AT-SPEC-eval-spec-and-contract-guide.md](010-AT-SPEC-eval-spec-and-contract-guide.md)                               | Eval spec + contract authoring guide                                             |
| 018 | [018-AT-SPEC-pb7-adapter-measurement-protocol-2026-05-12.md](018-AT-SPEC-pb7-adapter-measurement-protocol-2026-05-12.md) | PB-7 provider-adapter measurement protocol (gating doc; ISEDC v1 Q5 CTO binding) |
| 023 | [023-AT-SPEC-ciso-gate-failure-modes-2026-06-15.md](023-AT-SPEC-ciso-gate-failure-modes-2026-06-15.md)                   | CISO PASS/FAIL gate failure-mode reference                                       |
| 026 | [026-AT-SPEC-refiner-core-api-2026-06-20.md](026-AT-SPEC-refiner-core-api-2026-06-20.md)                                 | `@intentsolutions/refiner-core` API spec (value types, pure fns, RefinerStrategy; D4 + D8) |

### OD — Operations & Deployment

| #   | File                                           | Description |
| --- | ---------------------------------------------- | ----------- |
| 006 | [006-OD-STAT-status.md](006-OD-STAT-status.md) | Status      |

### AA — Audits & After-Action Reports

| #   | File                                                                                                                   | Description                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 019 | [019-AA-AUDT-appaudit-devops-playbook.md](019-AA-AUDT-appaudit-devops-playbook.md)                                     | Operator-grade DevOps playbook (appaudit)                                  |
| 020 | [020-AA-AACR-release-hardening-iep-P2-2026-05-21.md](020-AA-AACR-release-hardening-iep-P2-2026-05-21.md)               | IEP Priority 2 release-hardening AAR                                       |
| 022 | [022-AA-AACR-staging-stays-staging-forensics-2026-06-11.md](022-AA-AACR-staging-stays-staging-forensics-2026-06-11.md) | Staging-stays-staging production-Rekor promotion forensics                 |
| 024 | [024-AA-AACR-real-provider-dogfood-2026-06-17.md](024-AA-AACR-real-provider-dogfood-2026-06-17.md)                     | Real-provider dogfood AAR                                                  |
| 025 | [025-AA-AACR-configurable-openai-compatible-provider-2026-06-16.md](025-AA-AACR-configurable-openai-compatible-provider-2026-06-16.md) | Configurable OpenAI-compatible provider AAR                               |
| 027 | [027-AA-AACR-refiner-v0.1.0-release-2026-06-21.md](027-AA-AACR-refiner-v0.1.0-release-2026-06-21.md)                   | `@intentsolutions/refiner-core` + `@intentsolutions/refiner` v0.1.0 released to npm (published, SLSA provenance v1) |

## Chronological Listing

| #   | Code     | File                                                               |
| --- | -------- | ------------------------------------------------------------------ |
| 001 | PP-BCASE | [business-case.md](001-PP-BCASE-business-case.md)                  |
| 002 | PP-PRD   | [product-requirements.md](002-PP-PRD-product-requirements.md)      |
| 003 | AT-ARCH  | [architecture.md](003-AT-ARCH-architecture.md)                     |
| 004 | PP-UJRN  | [user-journey.md](004-PP-UJRN-user-journey.md)                     |
| 005 | AT-SPEC  | [technical-spec.md](005-AT-SPEC-technical-spec.md)                 |
| 006 | OD-STAT  | [status.md](006-OD-STAT-status.md)                                 |
| 007 | PP-PLAN  | [master-build-blueprint.md](007-PP-PLAN-master-build-blueprint.md) |

## Epics

Durable epic reference files in [`epics/`](epics/):

| Epic                                                                           | File                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------- |
| [Epic Index](epics/README.md)                                                  | Table of contents and active epic                  |
| [Epic 01](epics/epic-01-repo-foundation-and-operating-standard.md)             | Repo Foundation and Operating Standard             |
| [Epic 02](epics/epic-02-spec-layer-and-contract-system.md)                     | Spec Layer and Contract System                     |
| [Epic 03](epics/epic-03-package-integrity-and-deterministic-checks.md)         | Package Integrity and Deterministic Checks         |
| [Epic 04](epics/epic-04-evidence-layer-persistence-and-run-lifecycle.md)       | Evidence Layer, Persistence and Run Lifecycle      |
| [Epic 05](epics/epic-05-trigger-harness-and-skill-roster-simulation.md)        | Trigger Harness and Skill Roster Simulation        |
| [Epic 06](epics/epic-06-functional-execution-harness-and-observation-layer.md) | Functional Execution Harness and Observation Layer |
| [Epic 07](epics/epic-07-judgment-layer-calibration-and-model-matrix.md)        | Judgment Layer, Calibration and Model Matrix       |
| [Epic 08](epics/epic-08-regression-baseline-scoring-cli-and-ci-gate.md)        | Regression Baseline, Scoring CLI and CI Gate       |
| [Epic 09](epics/epic-09-optimizer-and-experiment-engine.md)                    | Optimizer and Experiment Engine                    |
| [Epic 10](epics/epic-10-team-product-eval-packs-and-drift-operations.md)       | Team/Product Eval Packs and Drift Operations       |

## Templates & References Library

Local, self-contained library of templates, reference standards, agent patterns, and epic workflow diagrams.

### Templates ([`templates/`](templates/))

| Directory                                        | Contents                             | Source Tier            |
| ------------------------------------------------ | ------------------------------------ | ---------------------- |
| [`skill-templates/`](templates/skill-templates/) | 6 SKILL.md structural patterns       | Tier 1 (skill-creator) |
| [`eval-schemas/`](templates/eval-schemas/)       | Eval JSON schemas (evals.json, etc.) | Tier 1 (skill-creator) |

### References ([`references/`](references/))

| Directory                                                     | Contents                                                      | Source Tier       |
| ------------------------------------------------------------- | ------------------------------------------------------------- | ----------------- |
| [`skill-standards/`](references/skill-standards/)             | AgentSkills.io spec, source-of-truth, frontmatter, validation | Tier 0–1          |
| [`eval-patterns/`](references/eval-patterns/)                 | Eval methodology, workflows, output patterns                  | Tier 1            |
| [`agents/`](references/agents/)                               | Grader, comparator, analyzer agent patterns                   | Tier 1            |
| [`enterprise-standards/`](references/enterprise-standards/)   | 100-point rubric, production validator schema registry        | Tier 0, 3         |
| [`drift-and-consistency/`](references/drift-and-consistency/) | Drift categories, source-of-truth hierarchy                   | Tier 1            |
| [`epic-workflows/`](references/epic-workflows/)               | 10 ASCII workflow diagrams                                    | Tier 3 (authored) |

## Summary

- **Total documents:** 27 + 10 epics + templates & references library (~40 files)
- **Categories used:** 5 (PP, AT, OD, TQ, AA)
- **Next sequence number:** 028
- **Note:** the per-category tables above list a subset; the per-doc files in this directory are the canonical source. Rebuild via `/doc-filing` index when next refreshed.
