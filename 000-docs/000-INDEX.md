# Document Index: j-rig-binary-eval

> Release-quality evaluation harness and rollout gate for Claude Skills

**Last Updated:** 2026-07-10

## By Category

### PP — Product & Planning

| #   | File                                                                           | Description                        |
| --- | ------------------------------------------------------------------------------ | ---------------------------------- |
| 001 | [001-PP-BCASE-business-case.md](001-PP-BCASE-business-case.md)                 | Business case                      |
| 002 | [002-PP-PRD-product-requirements.md](002-PP-PRD-product-requirements.md)       | Product requirements               |
| 004 | [004-PP-UJRN-user-journey.md](004-PP-UJRN-user-journey.md)                     | User journey                       |
| 007 | [007-PP-PLAN-master-build-blueprint.md](007-PP-PLAN-master-build-blueprint.md) | Master build blueprint (canonical) |

### AT — Architecture & Technical

| #   | File                                                                                                                     | Description                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 003 | [003-AT-ARCH-architecture.md](003-AT-ARCH-architecture.md)                                                               | Architecture                                                                      |
| 005 | [005-AT-SPEC-technical-spec.md](005-AT-SPEC-technical-spec.md)                                                           | Technical spec                                                                    |
| 010 | [010-AT-SPEC-eval-spec-and-contract-guide.md](010-AT-SPEC-eval-spec-and-contract-guide.md)                               | Eval spec + contract authoring guide                                              |
| 018 | [018-AT-SPEC-pb7-adapter-measurement-protocol-2026-05-12.md](018-AT-SPEC-pb7-adapter-measurement-protocol-2026-05-12.md) | PB-7 provider-adapter measurement protocol (gating doc; ISEDC v1 Q5 CTO binding)  |
| 021 | [021-AT-ARCH-repo-blueprint-2026-06-10.md](021-AT-ARCH-repo-blueprint-2026-06-10.md)                                     | Per-repo blueprint (Blueprint-C application)                                       |
| 023 | [023-AT-SPEC-ciso-gate-failure-modes-2026-06-15.md](023-AT-SPEC-ciso-gate-failure-modes-2026-06-15.md)                   | CISO PASS/FAIL gate failure-mode reference                                        |
| 026 | [026-AT-SPEC-refiner-core-api-2026-06-20.md](026-AT-SPEC-refiner-core-api-2026-06-20.md)                                 | `@intentsolutions/refiner-core` API spec (value types, pure fns, RefinerStrategy) |
| 029 | [029-AT-SPEC-refiner-core-api-2026-07-08.md](029-AT-SPEC-refiner-core-api-2026-07-08.md)                                 | `@intentsolutions/refiner-core` public API spec (documents the v0.2.0 surface)    |

### OD — Operations & Deployment

| #   | File                                                                    | Description                        |
| --- | ----------------------------------------------------------------------- | ---------------------------------- |
| 006 | [006-OD-STAT-status.md](006-OD-STAT-status.md)                          | Status                             |
| 008 | [008-OD-REPT-release-v0.2.7.md](008-OD-REPT-release-v0.2.7.md)          | Release report — v0.2.7            |
| 009 | [009-OD-REPT-epic-01-aar.md](009-OD-REPT-epic-01-aar.md)                | Epic 01 after-action report        |
| 011 | [011-OD-REPT-epic-02-aar.md](011-OD-REPT-epic-02-aar.md)                | Epic 02 after-action report        |
| 012 | [012-OD-REPT-epic-03-aar.md](012-OD-REPT-epic-03-aar.md)                | Epic 03 after-action report        |
| 013 | [013-OD-REPT-epic-04-aar.md](013-OD-REPT-epic-04-aar.md)                | Epic 04 after-action report        |
| 014 | [014-OD-REPT-epic-05-aar.md](014-OD-REPT-epic-05-aar.md)                | Epic 05 after-action report        |
| 015 | [015-OD-REPT-epic-06-aar.md](015-OD-REPT-epic-06-aar.md)                | Epic 06 after-action report        |
| 016 | [016-OD-REPT-epic-07-aar.md](016-OD-REPT-epic-07-aar.md)                | Epic 07 after-action report        |
| 017 | [017-OD-REPT-epic-08-aar.md](017-OD-REPT-epic-08-aar.md)                | Epic 08 after-action report        |

### TQ — Testing & Quality

| #   | File                                                                                                       | Description                                                    |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 010 | [010-TQ-SOPS-audit-harness-baseline-2026-05-01.md](010-TQ-SOPS-audit-harness-baseline-2026-05-01.md)       | Audit-harness testing baseline (Intent Solutions Testing SOP) |

> **Numbering note:** two documents share sequence `010` (`010-AT-SPEC-…` and `010-TQ-SOPS-…`) — a filing collision predating this index. Both are retained as-is; renumbering would break inbound references. Next new doc uses `030`.

### AA — Audits & After-Action Reports

| #   | File                                                                                                                                  | Description                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 019 | [019-AA-AUDT-appaudit-devops-playbook.md](019-AA-AUDT-appaudit-devops-playbook.md)                                                   | Operator-grade DevOps playbook (appaudit)                                                                          |
| 020 | [020-AA-AACR-release-hardening-iep-P2-2026-05-21.md](020-AA-AACR-release-hardening-iep-P2-2026-05-21.md)                             | IEP Priority 2 release-hardening AAR                                                                               |
| 022 | [022-AA-AACR-staging-stays-staging-forensics-2026-06-11.md](022-AA-AACR-staging-stays-staging-forensics-2026-06-11.md)               | Staging-stays-staging production-Rekor promotion forensics                                                        |
| 024 | [024-AA-AACR-real-provider-dogfood-2026-06-17.md](024-AA-AACR-real-provider-dogfood-2026-06-17.md)                                   | Real-provider behavioral dogfood AAR (iaj-E10)                                                                     |
| 025 | [025-AA-AACR-configurable-openai-compatible-provider-2026-06-16.md](025-AA-AACR-configurable-openai-compatible-provider-2026-06-16.md) | Configurable OpenAI-compatible provider AAR (DeepSeek / Kimi / OpenRouter)                                        |
| 027 | [027-AA-AACR-refiner-v0.1.0-release-2026-06-21.md](027-AA-AACR-refiner-v0.1.0-release-2026-06-21.md)                                 | Skill Refiner npm release — `@intentsolutions/refiner-core` + `@intentsolutions/refiner` v0.1.0 (SLSA provenance) |

### DR — Decision Records & Findings

| #   | File                                                                                                                                              | Description                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 028 | [028-DR-FIND-jrig-eval-criteria-ids-and-deterministic-validation-2026-06-28.md](028-DR-FIND-jrig-eval-criteria-ids-and-deterministic-validation-2026-06-28.md) | Deep-dive: two j-rig eval-engine bugs (criteria-id binding + deterministic validation) that inflated evals into false NO-SHIPs |

## Chronological Listing

| #   | Code     | File                                                                                                         |
| --- | -------- | ------------------------------------------------------------------------------------------------------------ |
| 001 | PP-BCASE | [business-case.md](001-PP-BCASE-business-case.md)                                                            |
| 002 | PP-PRD   | [product-requirements.md](002-PP-PRD-product-requirements.md)                                                |
| 003 | AT-ARCH  | [architecture.md](003-AT-ARCH-architecture.md)                                                               |
| 004 | PP-UJRN  | [user-journey.md](004-PP-UJRN-user-journey.md)                                                               |
| 005 | AT-SPEC  | [technical-spec.md](005-AT-SPEC-technical-spec.md)                                                           |
| 006 | OD-STAT  | [status.md](006-OD-STAT-status.md)                                                                           |
| 007 | PP-PLAN  | [master-build-blueprint.md](007-PP-PLAN-master-build-blueprint.md)                                           |
| 008 | OD-REPT  | [release-v0.2.7.md](008-OD-REPT-release-v0.2.7.md)                                                           |
| 009 | OD-REPT  | [epic-01-aar.md](009-OD-REPT-epic-01-aar.md)                                                                 |
| 010 | AT-SPEC  | [eval-spec-and-contract-guide.md](010-AT-SPEC-eval-spec-and-contract-guide.md)                               |
| 010 | TQ-SOPS  | [audit-harness-baseline.md](010-TQ-SOPS-audit-harness-baseline-2026-05-01.md)                                |
| 011 | OD-REPT  | [epic-02-aar.md](011-OD-REPT-epic-02-aar.md)                                                                 |
| 012 | OD-REPT  | [epic-03-aar.md](012-OD-REPT-epic-03-aar.md)                                                                 |
| 013 | OD-REPT  | [epic-04-aar.md](013-OD-REPT-epic-04-aar.md)                                                                 |
| 014 | OD-REPT  | [epic-05-aar.md](014-OD-REPT-epic-05-aar.md)                                                                 |
| 015 | OD-REPT  | [epic-06-aar.md](015-OD-REPT-epic-06-aar.md)                                                                 |
| 016 | OD-REPT  | [epic-07-aar.md](016-OD-REPT-epic-07-aar.md)                                                                 |
| 017 | OD-REPT  | [epic-08-aar.md](017-OD-REPT-epic-08-aar.md)                                                                 |
| 018 | AT-SPEC  | [pb7-adapter-measurement-protocol.md](018-AT-SPEC-pb7-adapter-measurement-protocol-2026-05-12.md)            |
| 019 | AA-AUDT  | [appaudit-devops-playbook.md](019-AA-AUDT-appaudit-devops-playbook.md)                                       |
| 020 | AA-AACR  | [release-hardening-iep-P2.md](020-AA-AACR-release-hardening-iep-P2-2026-05-21.md)                            |
| 021 | AT-ARCH  | [repo-blueprint.md](021-AT-ARCH-repo-blueprint-2026-06-10.md)                                                |
| 022 | AA-AACR  | [staging-stays-staging-forensics.md](022-AA-AACR-staging-stays-staging-forensics-2026-06-11.md)             |
| 023 | AT-SPEC  | [ciso-gate-failure-modes.md](023-AT-SPEC-ciso-gate-failure-modes-2026-06-15.md)                              |
| 024 | AA-AACR  | [real-provider-dogfood.md](024-AA-AACR-real-provider-dogfood-2026-06-17.md)                                  |
| 025 | AA-AACR  | [configurable-openai-compatible-provider.md](025-AA-AACR-configurable-openai-compatible-provider-2026-06-16.md) |
| 026 | AT-SPEC  | [refiner-core-api.md](026-AT-SPEC-refiner-core-api-2026-06-20.md)                                            |
| 027 | AA-AACR  | [refiner-v0.1.0-release.md](027-AA-AACR-refiner-v0.1.0-release-2026-06-21.md)                                |
| 028 | DR-FIND  | [jrig-eval-criteria-ids-and-deterministic-validation.md](028-DR-FIND-jrig-eval-criteria-ids-and-deterministic-validation-2026-06-28.md) |
| 029 | AT-SPEC  | [refiner-core-api.md](029-AT-SPEC-refiner-core-api-2026-07-08.md)                                            |

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

- **Total documents:** 30 numbered docs (`001`–`029`, with two `010`s) + 10 epics + templates & references library
- **Categories used:** 6 — PP, AT, OD, TQ, AA, DR
- **Next sequence number:** 030
- **Note:** every per-doc file in this directory is the canonical source; this index is the navigation layer. Rebuild via `/doc-filing` (or `/validate-consistency`, which flags index drift) when docs are added.
