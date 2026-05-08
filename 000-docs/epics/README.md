# Epic Index — J-Rig Binary Eval

10 epics, executed sequentially. Each epic is a durable reference file that Beads point back to.

**Status (2026-05-07):** All 10 epics complete. Project is at v0.14.0 with 6 CLI commands wired (`check`, `validate`, `eval`, `report`, `optimize`, `drift`).

| # | Epic | Status | Closed | File |
|---|------|--------|--------|------|
| 01 | Repo Foundation and Operating Standard | Done | 2026-03-29 | [epic-01](epic-01-repo-foundation-and-operating-standard.md) |
| 02 | Spec Layer and Contract System | Done | 2026-03-29 | [epic-02](epic-02-spec-layer-and-contract-system.md) |
| 03 | Package Integrity and Deterministic Checks | Done | 2026-03-29 | [epic-03](epic-03-package-integrity-and-deterministic-checks.md) |
| 04 | Evidence Layer, Persistence, and Run Lifecycle | Done | 2026-03-29 | [epic-04](epic-04-evidence-layer-persistence-and-run-lifecycle.md) |
| 05 | Trigger Harness and Skill Roster Simulation | Done | 2026-03-29 | [epic-05](epic-05-trigger-harness-and-skill-roster-simulation.md) |
| 06 | Functional Execution Harness and Observation Layer | Done | 2026-03-29 | [epic-06](epic-06-functional-execution-harness-and-observation-layer.md) |
| 07 | Judgment Layer, Calibration, and Model Matrix | Done | 2026-03-29 | [epic-07](epic-07-judgment-layer-calibration-and-model-matrix.md) |
| 08 | Regression, Baseline, Scoring, CLI, and CI Gate | Done | 2026-03-29 | [epic-08](epic-08-regression-baseline-scoring-cli-and-ci-gate.md) |
| 09 | Optimizer and Experiment Engine | Done | 2026-03-29 | [epic-09](epic-09-optimizer-and-experiment-engine.md) |
| 10 | Team Product, Eval Packs, and Drift Operations | Done | 2026-03-29 | [epic-10](epic-10-team-product-eval-packs-and-drift-operations.md) |

## Dependency Chain (executed)

```
Epic 01 → Epic 02 → Epic 03 → Epic 04 → Epic 05 → Epic 06 → Epic 07 → Epic 08 → Epic 09 → Epic 10
```

All 10 epics shipped between 2026-03-29 16:18 UTC (epic 01 first commit) and 2026-03-29 19:46 UTC (epic 10 first commit). Per-epic merge PRs: #4 → #13.

## CLI surface (post-Epic 10)

```
j-rig check <skill-dir>     # Package integrity (Epic 03)
j-rig validate <file>       # Eval-spec / contract validation (Epic 02)
j-rig eval <skill-dir>      # 7-layer behavioral eval (Epics 05-08)
j-rig report                # Query results from evidence DB (Epic 04)
j-rig optimize              # Failure clustering + improvement suggestions (Epic 09)
j-rig drift                 # Reevaluation gating (Epic 10)
```

Bin name: `j-rig` (with hyphen). Install: `cd packages/cli && pnpm build && ln -sf $PWD/dist/index.js ~/.local/bin/j-rig`.

## Beads convention

Every Bead under an epic should include:

```
Reference doc: 000-docs/epics/epic-NN-<name>.md
This task is governed by the epic reference doc above.
```

## Master Blueprint

Full product blueprint: [007-PP-PLAN-master-build-blueprint.md](../007-PP-PLAN-master-build-blueprint.md)
