# Changelog

All notable changes to `j-rig-binary-eval` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pending

- **`@j-rig/*` v2.0.0 major bump** per DR-018 ratification (consume kernel `EvidenceBundlePayload` Option α-minus). Gated on `iaj-E02b` precondition (`iec-E12` v0.2.0 release of `@intentsolutions/core`).
- npm publish path (currently no `pnpm publish` step in release.yml; consider when downstream consumers need npm-shipped `@j-rig/*` packages — separate workstream).

## [v1.1.0] - 2026-05-26

### Added — stub-provider opt-in API (`iaj-stub-provider`, IEP P2)

Closes `bd_000-projects-lcgu` (P0, partial — opt-in gate + banner discipline; real Anthropic adapter / PB-7 implementation remains open under the same bead as separate scope going forward).

Stub providers (used in tests and demos) now require explicit opt-in. The opt-in is enforced inside the stub provider constructors via `assertStubAllowed()` — see commit `24695ac` (refactor per Gemini PR #75 review). Default posture: stub usage refuses with a clear error unless `EVAL_STUB_ALLOW=1` is set; banner discipline confirms the consumer is intentionally running with stubs.

### Fixed — release.yml `|| true` removal (`iaj-release-test-bypass`, IEP P2)

Closes `bd_000-projects-d8au` (P0). Previous `release.yml` masked test failures with `|| true` on every test runner invocation (Makefile/test, pnpm test, pytest, cargo test, go test). A red test suite could ship a tagged release with green CI signals. All 5 suffixes removed; failing tests now block releases. See PR #75 + companion AAR `000-docs/020-AA-AACR-release-hardening-iep-P2-2026-05-21.md`.

### Fixed — release.yml build-before-test invariant (`iaj-release-ci-build-before-test`)

PR #76 (2026-05-26). After `|| true` was removed in v1.1.0's iep-P2 work, the latent failure surfaced: `pnpm run test` ran without `pnpm run build` first, so vitest could not resolve `@j-rig/cli`'s import of `@j-rig/core` (the `exports` field points at `dist/` which didn't exist). Added a `Build workspace packages` step before the `Verify readiness` step. Verified locally: 361/361 tests pass after build. Root cause flagged by the IEP thinker-canon panel review (Beck finding #1, 2026-05-25).

### Changed — release.yml rewritten to tag-trigger-only (`iaj-release-yml-branch-protection-bypass`)

Closes `bd_000-projects-bj5m` (P1). Previous workflow fired on push-to-main and auto-bumped version from commit messages, then tried to push the bump commit + tag back to main — fails with `GH006: Protected branch update failed` because main is branch-protected. 3 consecutive Release runs post-v1.0.0 failed for this reason and produced orphan tags (v1.0.1 + v1.1.0 pointing at unreachable commits; cleaned up 2026-05-26 session).

New shape mirrors `intent-eval-core/.github/workflows/release.yml`:
- Tag-push trigger only (`v*.*.*`)
- Drift guard: verify tag matches `package.json#version`
- Full check chain: build + lint + typecheck + test
- `gh release create` with auto-generated notes

Version bumping moves to PR-flow: engineer opens PR with bump + CHANGELOG, merges to main (branch protection respected), then manually tags from main HEAD → release.yml fires.

### Changed — Documentation

- IEP `/appaudit` baseline filed (PR #74)

### Quality posture

- `package.json#version` bumped to `1.1.0`
- `version.txt` synced to `1.1.0`

### Why minor, not patch

The stub-provider opt-in is a new public-API gate — consumers of `@j-rig/*` who relied on stubs working unconditionally now must opt-in. Per SemVer this is additive consumer-visible behavior → MINOR. The release.yml workflow rewrite is internal infrastructure (no consumer-visible API change). The build-before-test fix is internal CI correctness.

## [v1.0.0] - 2026-05-19

### Changed — License (BREAKING)

- **Relicensed from MIT to Apache 2.0.** Deliberate alignment with the rest of the Intent Eval Platform ecosystem (`intent-eval-lab`, `intent-eval-core`) so every repo ships under a single OSI-approved license with explicit patent-grant language.
- Existing `0.x` artifacts remain available under their original MIT terms. All releases `>= 1.0.0` are Apache 2.0.
- Added `NOTICE` file per Apache 2.0 best practice with copyright attribution and license summary.
- README license badge + section updated to reflect the change with a backward-compat note.
- `version.txt` and `package.json` versions synced to `1.0.0` (resolving prior drift between the two files in passing).

No code, behavior, dep, or CLI changes in this release — license-only bump cut as MAJOR for legal clarity and consumer review signaling.

## [v0.23.2] - 2026-05-13

- chore(deps): bump pnpm/action-setup from 5 to 6 (#23) (f4505c5)


## [v0.23.1] - 2026-05-13

- chore(deps): bump better-sqlite3 from 12.8.0 to 12.10.0 (#27) (d520cf0)
- chore(deps-dev): bump typescript-eslint from 8.58.0 to 8.59.3 (#38) (340aa2b)
- chore(deps-dev): bump @types/node from 25.5.0 to 25.7.0 (#28) (401d6f5)
- chore(deps): bump zod from 4.3.6 to 4.4.3 (#36) (5df1eb0)


## [v0.23.0] - 2026-05-13

- feat(M4 phase 2c): score-card scoring + Decision Record draft generator (#55) (fc2467f)


## [v0.22.0] - 2026-05-13

- feat(M4 phase 2b): EC-1..EC-5 eval-case harness (PB-7 execution surface) (#54) (d2e96be)


## [v0.21.0] - 2026-05-13

- feat(M4 phase 2a): Provider interface + CISO gates G-1, G-2 (#53) (23299e6)


## [v0.20.1] - 2026-05-13

- docs(M4 PB-7): provider-adapter measurement protocol (CTO Q5 binding gate) (#52) (f32b8cb)


## [v0.20.0] - 2026-05-13

- feat(M3 phase 4): cosign --sign integration in j-rig emit-evidence (#50) (c252c87)


## [v0.19.0] - 2026-05-13

- feat(M3 phase 3b): MM-2 through MM-6 checkers + fixtures (#49) (b2fae3b)


## [v0.18.0] - 2026-05-13

- feat(M3 phase 3a): MM-N infrastructure + MM-1 async-race checker + fixtures (#48) (9d10659)


## [v0.17.0] - 2026-05-13

- feat(M3 phase 2 / PB-8): AGENTS.md parser (#56) (ddfb509)


## [v0.16.0] - 2026-05-13

- feat(M3 phase 1): Evidence Bundle Zod schemas + I/O adapters + emit-evidence CLI (#46) (d65b3e1)


## [v0.15.3] - 2026-05-13

- chore(ci): remove broken gemini-review workflow (switching to Gemini app) (#51) (c87653c)


## [v0.15.2] - 2026-05-12

- chore(deps): bump commander from 13.1.0 to 14.0.3 (#22) (2659b9c)


## [v0.15.1] - 2026-05-12

- chore(deps-dev): bump prettier from 3.8.1 to 3.8.3 (#30) (810fa3d)


## [v0.15.0] - 2026-05-08

- feat(governance): bring skill spec sources of truth into the repo (#41) (7abdc53)
- docs(epics): update epic-index README to reflect completed state (#40) (6872040)


## [v0.14.1] - 2026-05-01

- chore(test): install @intentsolutions/audit-harness v0.1.0 (P6 batch) (#35) (86dd090)


## [v0.14.0] - 2026-04-01

- chore(deps-dev): bump typescript-eslint from 8.57.2 to 8.58.0 (#16) (d211fd2)
- chore(deps): bump pnpm/action-setup from 4 to 5 (#15) (d8f8dc9)
- feat(cli): wire up 6 CLI commands for evaluation harness (#14) (ab71522)


## [v0.13.0] - 2026-03-30

- feat: align skill validation with Anthropic best practices (2026) (06171dd)


## [v0.12.0] - 2026-03-30

- Merge pull request #13 from jeremylongshore/feature/epic-10-team-product-eval-packs-drift (dbe8c53)
- feat(epic-10): add drift detection, eval packs, and reevaluation (152c680)


## [v0.11.0] - 2026-03-30

- Merge pull request #12 from jeremylongshore/feature/epic-09-optimizer-and-experiment-engine (1e6762e)
- feat(epic-09): add optimizer with failure clustering and experiment engine (1cc802b)


## [v0.10.0] - 2026-03-30

- Merge pull request #11 from jeremylongshore/feature/epic-08-regression-baseline-scoring-cli (499c95a)
- docs(epic-08): add epic 08 after action report (90dd6c0)
- feat(epic-08): add regression, baseline, scoring, and launch reports (bdffce6)


## [v0.9.0] - 2026-03-30

- Merge pull request #10 from jeremylongshore/feature/epic-07-judgment-layer-and-model-matrix (f7ef171)
- docs(epic-07): add epic 07 after action report (15142ac)
- feat(epic-07): add judgment layer with calibration and model matrix (460db40)


## [v0.8.0] - 2026-03-30

- Merge pull request #9 from jeremylongshore/feature/epic-06-functional-execution-and-observation (6aede90)
- docs(epic-06): add epic 06 after action report (69d31d3)
- feat(epic-06): add functional execution harness and observation layer (42921d3)


## [v0.7.0] - 2026-03-30

- Merge pull request #8 from jeremylongshore/feature/epic-05-trigger-harness-and-skill-roster-simulation (6807a73)
- docs(epic-05): add epic 05 after action report (73e4431)
- feat(epic-05): add trigger harness with roster, runner, and metrics (957053b)


## [v0.6.0] - 2026-03-29

- Merge pull request #7 from jeremylongshore/feature/epic-04-evidence-layer-persistence-and-run-lifecycle (1437524)
- docs(epic-04): add epic 04 after action report (2153d81)
- test(epic-04): add evidence persistence and lifecycle tests (7ad209c)
- feat(epic-04): add SQLite evidence layer with run lifecycle (102a86a)


## [v0.5.0] - 2026-03-29

- Merge pull request #6 from jeremylongshore/feature/epic-03-package-integrity-and-deterministic-checks (bbdac59)
- ci: add Gemini AI code review workflow (3d7609b)
- docs(epic-03): add epic 03 after action report (92e2bb4)
- test(epic-03): add package fixtures and deterministic check tests (d0d6696)
- feat(epic-03): add package integrity checker and deterministic registry (6b7ff8c)


## [v0.4.0] - 2026-03-29

- Merge pull request #5 from jeremylongshore/feature/epic-02-spec-layer-and-contract-system (ae5bbc3)
- docs(epic-02): add spec/contract authoring guide and epic 02 AAR (904f9d1)
- test(epic-02): add schema fixtures and comprehensive test suite (11147d7)
- feat(epic-02): add YAML and SKILL.md parsing utilities (7ba3005)
- feat(epic-02): add eval spec, contract, criterion, and test case schemas (902c9aa)


## [v0.3.0] - 2026-03-29

- Merge pull request #4 from jeremylongshore/feature/epic-01-repo-foundation-operating-standard (8aebba8)
- docs(epic-01): add epic 01 after action report (eee6c5b)
- docs(epic-01): align repo docs with workspace foundation (33c8653)
- ci(epic-01): update workflows for pnpm workspace (ae38f71)
- feat(epic-01): add quality guardrails and test baseline (9a1bd5e)
- feat(epic-01): scaffold pnpm workspace and TypeScript baseline (7bd30c0)
- docs: update CLAUDE.md for workspace foundation (c077f92)


## [v0.2.11] - 2026-03-25

- chore: update FUNDING.yml with GitHub Sponsors + Buy Me a Coffee (ac8ff72)


## [v0.2.10] - 2026-03-25

- chore: update FUNDING.yml with GitHub Sponsors + Buy Me a Coffee (55ea090)


## [v0.2.9] - 2026-03-25

- docs: add release report for v0.2.7 (91e6221)


## [v0.2.8] - 2026-03-25

- chore: add .gist-id for release automation (4fe7493)


All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.7] - 2026-03-25

### Added
- Templates & references library (32 files)
  - 6 skill templates from skill-creator (Tier 1)
  - Eval JSON schemas
  - 4 skill-standards references (AgentSkills.io spec, source-of-truth, frontmatter, validation)
  - 3 eval-patterns references
  - 3 agent patterns (grader, comparator, analyzer)
  - 2 enterprise standards
  - 2 drift-and-consistency references
  - 10 epic workflow diagrams
- Epic reference documents 05-10 (6 files, ~3000 lines)
- Pattern A README with one-pager and operator-grade system analysis

### Changed
- Audited library for bloat: removed 9 files (975 lines) already consumed or wrong product
- Added cross-reference headers to skill-standards files
- Mapped all library files to specific beads (43 bd update commands)

## [0.2.6] - 2026-03-24

### Added
- Epic 04 reference file (evidence layer, persistence, run lifecycle)

## [0.2.5] - 2026-03-24

### Added
- Epic 03 reference file (package integrity and deterministic checks)

## [0.2.4] - 2026-03-24

### Added
- Epic 02 reference file (spec layer and contract system)

## [0.2.3] - 2026-03-24

### Added
- Epic index and Epic 01 reference file

## [0.2.2] - 2026-03-24

### Added
- Master build blueprint (007-PP-PLAN)

## [0.2.1] - 2026-03-24

### Fixed
- Clean up duplicate CHANGELOG entry from release workflow

## [0.2.0] - 2026-03-24

### Added
- Beads issue tracking integration
- Document filing index (000-INDEX.md)

## [0.1.0] - 2026-03-24

### Added
- Initial project setup with full governance
- README, LICENSE, CODE_OF_CONDUCT, CONTRIBUTING, SECURITY, SUPPORT
- CI/CD workflows (lint, test, release automation)
- Enterprise documentation set (6-doc planning suite)
- GitHub issue templates and PR template
- Dependabot configuration
- EditorConfig and gitattributes

[Unreleased]: https://github.com/jeremylongshore/j-rig-binary-eval/compare/v0.2.7...HEAD
[0.2.7]: https://github.com/jeremylongshore/j-rig-binary-eval/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/jeremylongshore/j-rig-binary-eval/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/jeremylongshore/j-rig-binary-eval/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/jeremylongshore/j-rig-binary-eval/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/jeremylongshore/j-rig-binary-eval/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jeremylongshore/j-rig-binary-eval/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jeremylongshore/j-rig-binary-eval/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jeremylongshore/j-rig-binary-eval/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeremylongshore/j-rig-binary-eval/releases/tag/v0.1.0
