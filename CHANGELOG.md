# Changelog

All notable changes to `j-rig-binary-eval` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Versioning note.** Sections below track the **monorepo root semver line**
> (the root `package.json#version`, mirrored to `version.txt`). Per-package
> publish tags (e.g. `rollout-gate-v*`) and pre-`1.0.0` orphan tags that never
> landed on `main` (e.g. `v1.0.1`) are intentionally not given their own
> sections. License changed from MIT to Apache 2.0 at `1.0.0`; all releases
> `>= 1.0.0` are Apache 2.0.

## [Unreleased]

### Added

- **Eval provider + judge hardening, and the eval→Evidence-Bundle bridge**
  (merged to main 2026-06-30). The published `@intentsolutions/jrig-cli`
  **0.1.2** release carries all four changes below — including the two
  provider fixes — as it was last cut at `0.1.1`, before any of these landed;
  a consumer pinning the CLI stops hitting the false NO-SHIP those bugs
  inflated.
  - `feat(eval)`: `j-rig eval --emit-bundle` now emits a real `gate-result/v1`
    Evidence Bundle from an eval run (#172).
  - `fix(providers)`: functional-exec `max_tokens` raised and length-truncation
    is now surfaced instead of silently returning a short/empty completion —
    the reasoning-model truncation that mis-scored control-prompt-heavy skills
    (#173).
  - `feat(cli)`: `j-rig scaffold-spec` generates a baseline eval-spec from a
    `SKILL.md` (#174).
  - `fix(providers)`: judge verdict is recovered from truncated / fenced JSON
    replies — structured `{verdict: yes|no}` responses are no longer
    mis-bucketed as `unsure`, which had inflated NO-SHIP (#175).
- **Skill-scoring gap-fill — adoption signal + intake verbs** (epic
  intent-eval-lab#206, beads `ig4h.4` + `ig4h.5`; ISEDC DR-103). Bumped
  `@intentsolutions/core` `0.8.0` → `0.9.0` (the kernel minor that added the
  `usage_events` + `human_reviews` entities) across the root, `@j-rig/core`, and
  `@intentsolutions/refiner-core`; `CONSUMED_KERNEL_VERSION` bumped in lockstep.
  - `@intentsolutions/refiner-core` `adoption.ts`: `computeAdoptionVerdict()` — a
    DETERMINISTIC time-decay adoption signal joining the baseline-value flag with a
    decayed usage rate into an advisory 2×2 (`keep`/`watch`/`deprecate_review`/
    `obsolete_review`/`hold`). AND-combined never averaged (no rolled score, C3);
    `now`-injected (pure, no `Date.now()`); per-tenant-first aggregation with
    under-volume exclusion; `ci`-vs-`plugin` source segregation; thresholds ship
    explicitly **provisional** until back-tested. The Thompson-sampling **bandit is
    rejected** for this signed surface (DR-103 D5). `toAdoptionObservations()`
    re-applies the kernel anti-gaming invariant at ingestion.
  - `@j-rig/cli`: `j-rig ingest-skill` (CASS session-quality gate ≥0.30,
    persist-but-exclude, no force-count path) and `j-rig review` (curated-signal
    thumb + open-ended rationale — explicitly NOT a signed `human-review/v1`
    predicate). Both write local SQLite via `@j-rig/db`; no OTel events minted.
  - `@j-rig/db` `skill-signals.ts`: two append-only intake fact tables
    (`skill_usage_events`, `skill_human_reviews`) with the `tenant_id` column in the
    first `CREATE TABLE` (DR-103 D2 B2.1) and C3-safe per-dimension rollups.
  - `@j-rig/core` `buildLaunchReport` now takes an injected clock (`opts.now`) so
    the launch-report artifact is replayable (DR-103 D5 B5.1), plus the additive
    opt-in `LaunchReport.adoptionVerdict?` field (the `RolloutDecision` union is
    NOT mutated — DR-103 D4).
- Kernel-migration safe slice (`iaj-E02`, IEP P1): the first non-breaking slice
  of the kernel schema migration (DR-018 § 6.4 Q2 Option α-minus). Lands the
  dependency bump + a belt-and-suspenders equivalence proof only; the full
  `@j-rig/*` predicate-body migration remained the single-coherent-PR work that
  shipped in `2.0.0`.
- Bumped `@intentsolutions/core` `0.2.0` → `0.3.1` — the published kernel now
  exports the folded `EvidenceStatement` row shape + cross-field invariants
  (`@intentsolutions/core/validators/v1/evidence-statement`).
- Added `packages/core/src/schemas/evidence-bundle.kernel-shadow.test.ts` — the
  behavioral secondary check DR-018 § 6.4 mandates for one major version cycle.
  Proves j-rig's local `EvidenceStatementSchema` and the kernel's agree on their
  genuinely-overlapping surface: in-toto wrapper constants, subject-name +
  bare-sha256 digest validation, and cross-field invariants I1
  (`subject[0].name === predicate.gate_id`) + I2
  (`subject[0].digest.sha256 === predicate.input_hash` sans `sha256:` prefix).

### Security

- Forensics + AAR (`iaj-staging-stays-staging-aar`): confirmed ZERO j-rig
  evidence rows were promoted from `sigstore_staging` to production-Rekor before
  DR-018 (CISO carve-out pre-merge gate satisfied). See
  `000-docs/022-AA-AACR-staging-stays-staging-forensics-2026-06-11.md`.

> **Pending follow-ups:** npm publish path for the private `@j-rig/*` workspace
> packages (currently no `pnpm publish` step in `release.yml`; revisit when
> downstream consumers need npm-shipped `@j-rig/*` packages — separate
> workstream).

## [2.1.0] - 2026-06-15

All seven workspace packages bump to `2.1.0` in lockstep with the root version.
`@intentsolutions/rollout-gate` is the only published package (separate
`rollout-gate-v*` publish tag); the remaining `@j-rig/*` workspace packages stay
internal to the monorepo.

### Added

- **`@intentsolutions/rollout-gate`** (#106): the rollout decision-logic extracted
  into a publishable, self-contained package (does not import the private
  `@j-rig/core`), published to npm with sigstore provenance via the separate
  `rollout-gate-v*` publish workflow.
- **Provider measurement adapters** (#110, #111): LiteLLM and Vercel AI SDK
  measurement adapters wired in via the iaj-E05 provider abstraction layer, plus
  an OpenAI stub adapter and a dependency-license audit (`license:audit`).
- **Tooling** (#113): PR-comment renderer, `AGENTS.md` parse CLI, and the v1→v2
  evidence-shape migrate codemod.

### Changed

- **Kernel authoring/v1 cutover** (#108): skill-frontmatter validation now reads
  from the kernel `@intentsolutions/core` `authoring/v1` single-source-of-truth
  instead of j-rig's local copy.
- **Release-workflow CISO hardening**: every `actions/checkout` in the release,
  emit-evidence, and rollout-gate publish jobs is now pinned to the pushed tag
  ref (`ref: ${{ github.ref }}`) per the ISEDC E09 DR reproducible-from-tag
  invariant — provenance is attributed to the exact tag bytes, never an implicit
  default ref.
- **CI / tooling lanes**: advisory `lint.yml` (yamllint + markdownlint, vendored
  shared IEP configs) (#117), `actionlint` lane (#115), `typos` spell-check lane
  (#114), `lefthook.yml` git-hooks config (#116), and the test enforcement wall
  — coverage floor + pre-commit hook + CI harness verify (#109). Added an ntfy
  CI-failure alert over the tailnet on a failed tag-release (#112) and a CISO
  gate G-1/G-2 failure-mode reference doc (#120).

### Fixed

- **emit-evidence v2 coverage read** (#118): the emit-evidence pipeline mode now
  reads nested v2 coverage dimensions correctly, so a passing gate cannot be
  reported with vacuous coverage.

### Security

- **CISO Gate G-1 leak-capture hardening** (#119, #118): Gate G-1 now captures
  log-file (filesystem) writes and OpenTelemetry spans as exfiltration channels,
  closing a class of leaks the gate previously did not observe.

> **Descoped — rides a future `2.1.x` routine release:** OpenTelemetry telemetry
> export (iaj-E08 / 5s7) is held out of `2.1.0` because it is externally blocked
> by iel-E12. It ships in a later routine release once that dependency lands.

## [2.0.0] - 2026-06-12

Full predicate-body migration from j-rig's `v0.1.0-draft` shape to the kernel
`@intentsolutions/core` `gate-result/v1` normative shape (DR-018 Option α). All
5 workspace packages bump to `2.0.0` in one coherent PR (#103). See
`MIGRATION.md` for the full field-mapping table and downstream consumer upgrade
instructions.

### Added

- **`MIGRATION.md`** at repo root: v1→v2 field-mapping table, CLI surface diff,
  downstream consumer upgrade instructions.
- Kernel dep `@intentsolutions/core` bumped `0.3.1` → `0.5.0` in root devDeps and
  added as a direct dep in `packages/core` (#102).
- NEW required predicate fields: `gate_name`, `gate_version`, `gate_reasons`,
  `coverage` (`dimensions_evaluated` + `dimensions_skipped`), `policy_ref`.
- NEW required TypeScript `ComposeStatementInput` fields: `gateName`,
  `gateVersion`, `gateReasons`, `coverage`, `policyRef`.
- NEW required CLI flags (direct mode): `--gate-name`, `--gate-version`,
  `--policy-ref`; NEW optional flags: `--gate-reason` (repeatable),
  `--coverage-evaluated` (repeatable), `--coverage-skipped` (repeatable).
- `LegacyBundleContainerSchema` + `LegacyBundleContainer` type: backward-compat
  read path for v1 `{ bundle_format: "json-array", rows: [...] }` bundles.
- `CoverageInput` interface in the writer: typed camelCase input for coverage
  fields. Reader now supports the v2 plain JSON array form directly.

### Changed

- **BREAKING — predicate body** (`iaj-E02`, DR-018):
  - `result` (PASS/FAIL/ADVISORY/NOT_APPLICABLE) renamed to `gate_decision`
    (pass/fail/advisory/error); values are now lowercase.
  - `timestamp` renamed to `evaluated_at`; timezone offset is now required.
  - `NOT_APPLICABLE` is no longer a `gate_decision` value — route it via
    `coverage.dimensions_skipped` instead (DR-018 § 279).
- **BREAKING — TypeScript API** (`ComposeStatementInput`): `result` →
  `gateDecision` (`"pass" | "fail" | "advisory" | "error"`); `timestamp` →
  `evaluatedAt`.
- **BREAKING — CLI** (`j-rig emit-evidence`): `--result` → `--gate-decision`
  (lowercase values; `NOT_APPLICABLE` still accepted for backward compat, routes
  to `coverage.dimensions_skipped`).
- **BREAKING — wire format** (`writeBundle(..., { format: "array" })`): v2 emits
  a plain JSON array (`EvidenceBundlePayload`) instead of the v1
  `{ bundle_format: "json-array", rows: [...] }` container. The reader still
  understands the v1 container form for backward-compatible reading.
- **Schema authority (Option α — one-cycle retention):**
  `EvidenceStatementSchema` is now the kernel's schema with j-rig's behavioral
  cross-field invariant checks (`superRefine`) layered on top as secondary
  belt-and-suspenders enforcement (remove in v3.0.0). `EvidenceBundleSchema` is
  now an alias for kernel's `EvidenceBundlePayloadSchema` (plain array); legacy
  container form available as `LegacyBundleContainerSchema`.
- **Unchanged (immutable per ISEDC CISO binding):** predicate URI
  `https://evals.intentsolutions.io/gate-result/v1`, statement type
  `https://in-toto.io/Statement/v1`, and `policy_hash` / `input_hash` / `runner`
  / `commit_sha` semantics.

### Fixed

- **2026-06-11 umbrella review** (#104, merged into 2.0.0):
  - **P0**: the judgment engine now forwards criterion params through `runCheck`;
    built-in parameterized checks (`contains`, `regex_match`, `min_length`,
    `max_length`) fail closed on missing params instead of passing vacuously.
  - CISO gates G-1/G-2 race the provider invocation against `timeoutMs` — hung
    adapters no longer block forever.
  - `emit-evidence --sign` defaults to the predicate body (cosign wraps it);
    `--full-statement` opts into the nested pre-formed Statement.
  - Coverage-floor parsing anchored to the vitest `thresholds` block.
  - Empty calibration golden sets fail closed; R9 digest invariant no longer
    fail-open; `commit_sha` sentinel fallback warns loudly.

## [1.2.0] - 2026-06-08

### Added

- **Signed `gate-result/v1` evidence for the dashboard** (#95, `nr75.11`):
  emit-evidence now produces signed gate-result/v1 evidence consumed by the IEP
  reports hub.
- **L2 doc-quality gates** installed (advisory on first run) (#84).

### Changed

- Wired **Codecov** + added `@vitest/coverage-v8` dev dep for coverage reporting
  (#83).
- Bumped the vendored `@intentsolutions/audit-harness` to `v1.1.5` (#93).
- Documentation: linked back to the Intent Eval Platform umbrella (#85).
- Dependency bumps: `eslint` 9.39.4 → 10.4.1 (#68), `yaml` 2.8.3 → 2.9.0 (#72),
  `@types/node` 25.7.0 → 25.9.1 (#77), `typescript-eslint` 8.59.3 → 8.60.0 (#79).
- Gitignore generated `reports/` gate output (#94).

## [1.1.0] - 2026-05-26

### Added

- **Stub-provider opt-in API** (`iaj-stub-provider`, IEP P2) (#75): stub
  providers (used in tests and demos) now require explicit opt-in, enforced
  inside the stub provider constructors via `assertStubAllowed()` (commit
  `24695ac`, refactor per Gemini PR #75 review). Default posture: stub usage
  refuses with a clear error unless `J_RIG_ALLOW_STUB=1` is set; banner discipline
  confirms the consumer is intentionally running with stubs. Closes
  `bd_000-projects-lcgu` (P0, partial — opt-in gate + banner; real Anthropic
  adapter / PB-7 implementation remains open under the same bead).

### Changed

- **`release.yml` rewritten to tag-trigger-only**
  (`iaj-release-yml-branch-protection-bypass`, #80): the previous workflow fired
  on push-to-main, auto-bumped version from commit messages, then tried to push
  the bump commit + tag back to a branch-protected `main` (`GH006`). 3
  consecutive post-`v1.0.0` Release runs failed this way and produced orphan tags
  (`v1.0.1` + `v1.1.0` pointing at unreachable commits; cleaned up in the
  2026-05-26 session). The new shape mirrors
  `intent-eval-core/.github/workflows/release.yml`: tag-push trigger only
  (`v*.*.*`), drift guard verifying the tag matches `package.json#version`, full
  check chain (build + lint + typecheck + test), `gh release create` with
  auto-generated notes. Version bumping moves to PR-flow. Closes
  `bd_000-projects-bj5m` (P1).
- **Documentation**: IEP `/appaudit` baseline filed (#74).
- **Quality posture**: `package.json#version` bumped to `1.1.0`; `version.txt`
  synced to `1.1.0`.

### Fixed

- **`release.yml` `|| true` removal** (`iaj-release-test-bypass`, IEP P2) (#75):
  the previous `release.yml` masked test failures with `|| true` on every test
  runner invocation (Makefile/test, pnpm test, pytest, cargo test, go test) — a
  red test suite could ship a tagged release with green CI signals. All 5
  suffixes removed; failing tests now block releases. See companion AAR
  `000-docs/020-AA-AACR-release-hardening-iep-P2-2026-05-21.md`. Closes
  `bd_000-projects-d8au` (P0).
- **`release.yml` build-before-test invariant**
  (`iaj-release-ci-build-before-test`, #76): after `|| true` was removed, the
  latent failure surfaced — `pnpm run test` ran without `pnpm run build` first,
  so vitest could not resolve `@j-rig/cli`'s import of `@j-rig/core` (the
  `exports` field points at `dist/`, which did not exist). Added a `Build
  workspace packages` step before the `Verify readiness` step. Verified locally:
  361/361 tests pass after build. Root cause flagged by the IEP thinker-canon
  panel review (Beck finding #1, 2026-05-25).

> **Why minor, not patch:** the stub-provider opt-in is a new public-API gate —
> consumers of `@j-rig/*` who relied on stubs working unconditionally now must
> opt in. Per SemVer this is additive consumer-visible behavior → MINOR. The
> `release.yml` rewrite and build-before-test fix are internal CI correctness.

## [1.0.0] - 2026-05-19

### Changed

- **BREAKING — relicensed from MIT to Apache 2.0.** Deliberate alignment with the
  rest of the Intent Eval Platform ecosystem (`intent-eval-lab`,
  `intent-eval-core`) so every repo ships under a single OSI-approved license
  with explicit patent-grant language. Existing `0.x` artifacts remain available
  under their original MIT terms; all releases `>= 1.0.0` are Apache 2.0.
- README license badge + section updated to reflect the change with a
  backward-compat note.
- `version.txt` and `package.json` versions synced to `1.0.0` (resolving prior
  drift between the two files in passing).

### Added

- `NOTICE` file per Apache 2.0 best practice, with copyright attribution and
  license summary.

> No code, behavior, dep, or CLI changes in this release — license-only bump cut
> as MAJOR for legal clarity and consumer review signaling.

## [0.23.2] - 2026-05-13

### Changed

- Bump `pnpm/action-setup` from 5 to 6 (#23) (f4505c5).

## [0.23.1] - 2026-05-13

### Changed

- Bump `better-sqlite3` from 12.8.0 to 12.10.0 (#27) (d520cf0).
- Bump `typescript-eslint` from 8.58.0 to 8.59.3 (#38) (340aa2b).
- Bump `@types/node` from 25.5.0 to 25.7.0 (#28) (401d6f5).
- Bump `zod` from 4.3.6 to 4.4.3 (#36) (5df1eb0).

## [0.23.0] - 2026-05-13

### Added

- M4 phase 2c: score-card scoring + Decision Record draft generator (#55)
  (fc2467f).

## [0.22.0] - 2026-05-13

### Added

- M4 phase 2b: EC-1..EC-5 eval-case harness (PB-7 execution surface) (#54)
  (d2e96be).

## [0.21.0] - 2026-05-13

### Added

- M4 phase 2a: Provider interface + CISO gates G-1, G-2 (#53) (23299e6).

## [0.20.1] - 2026-05-13

### Changed

- Docs (M4 PB-7): provider-adapter measurement protocol (CTO Q5 binding gate)
  (#52) (f32b8cb).

## [0.20.0] - 2026-05-13

### Added

- M3 phase 4: cosign `--sign` integration in `j-rig emit-evidence` (#50)
  (c252c87).

## [0.19.0] - 2026-05-13

### Added

- M3 phase 3b: MM-2 through MM-6 checkers + fixtures (#49) (b2fae3b).

## [0.18.0] - 2026-05-13

### Added

- M3 phase 3a: MM-N infrastructure + MM-1 async-race checker + fixtures (#48)
  (9d10659).

## [0.17.0] - 2026-05-13

### Added

- M3 phase 2 / PB-8: AGENTS.md parser (#56) (ddfb509).

## [0.16.0] - 2026-05-13

### Added

- M3 phase 1: Evidence Bundle Zod schemas + I/O adapters + emit-evidence CLI
  (#46) (d65b3e1).

## [0.15.3] - 2026-05-13

### Removed

- Remove the broken gemini-review workflow (switching to the Gemini app) (#51)
  (c87653c).

## [0.15.2] - 2026-05-12

### Changed

- Bump `commander` from 13.1.0 to 14.0.3 (#22) (2659b9c).

## [0.15.1] - 2026-05-12

### Changed

- Bump `prettier` from 3.8.1 to 3.8.3 (#30) (810fa3d).

## [0.15.0] - 2026-05-08

### Added

- Governance: bring skill spec sources of truth into the repo (#41) (7abdc53).

### Changed

- Docs (epics): update epic-index README to reflect completed state (#40)
  (6872040).

## [0.14.1] - 2026-05-01

### Added

- Install `@intentsolutions/audit-harness` v0.1.0 (P6 batch) (#35) (86dd090).

## [0.14.0] - 2026-04-01

### Added

- CLI: wire up 6 CLI commands for the evaluation harness (#14) (ab71522).

### Changed

- Bump `typescript-eslint` from 8.57.2 to 8.58.0 (#16) (d211fd2).
- Bump `pnpm/action-setup` from 4 to 5 (#15) (d8f8dc9).

## [0.13.0] - 2026-03-30

### Changed

- Align skill validation with Anthropic best practices (2026) (06171dd).

## [0.12.0] - 2026-03-30

### Added

- Epic 10: drift detection, eval packs, and reevaluation (#13) (152c680).

## [0.11.0] - 2026-03-30

### Added

- Epic 09: optimizer with failure clustering and experiment engine (#12)
  (1cc802b).

## [0.10.0] - 2026-03-30

### Added

- Epic 08: regression, baseline, scoring, and launch reports (#11) (bdffce6).

## [0.9.0] - 2026-03-30

### Added

- Epic 07: judgment layer with calibration and per-model matrix (#10) (460db40).

## [0.8.0] - 2026-03-30

### Added

- Epic 06: functional execution harness and observation layer (#9) (42921d3).

## [0.7.0] - 2026-03-30

### Added

- Epic 05: trigger harness with roster, runner, and metrics (#8) (957053b).

## [0.6.0] - 2026-03-29

### Added

- Epic 04: SQLite evidence layer with run lifecycle (#7) (102a86a), plus
  evidence persistence and lifecycle tests (7ad209c).

## [0.5.0] - 2026-03-29

### Added

- Epic 03: package integrity checker and deterministic registry (#6) (6b7ff8c),
  with package fixtures and deterministic check tests (d0d6696).
- CI: Gemini AI code review workflow (3d7609b).

## [0.4.0] - 2026-03-29

### Added

- Epic 02: eval spec, contract, criterion, and test case schemas (#5)
  (902c9aa), plus YAML and SKILL.md parsing utilities (7ba3005) and a
  comprehensive schema-fixtures test suite (11147d7).

## [0.3.0] - 2026-03-29

### Added

- Epic 01: scaffold pnpm workspace and TypeScript baseline (#4) (7bd30c0), plus
  quality guardrails and test baseline (9a1bd5e).

### Changed

- CI: update workflows for the pnpm workspace (ae38f71).
- Docs: align repo docs with the workspace foundation (33c8653); update
  CLAUDE.md for the workspace foundation (c077f92).

## [0.2.11] - 2026-03-25

### Changed

- Update `FUNDING.yml` with GitHub Sponsors + Buy Me a Coffee (ac8ff72).

## [0.2.10] - 2026-03-25

### Changed

- Update `FUNDING.yml` with GitHub Sponsors + Buy Me a Coffee (55ea090).

## [0.2.9] - 2026-03-25

### Added

- Release report for v0.2.7 (91e6221).

## [0.2.8] - 2026-03-25

### Added

- `.gist-id` for release automation (4fe7493).

## [0.2.7] - 2026-03-25

### Added

- Templates & references library (32 files): 6 skill templates from
  skill-creator (Tier 1), eval JSON schemas, 4 skill-standards references
  (AgentSkills.io spec, source-of-truth, frontmatter, validation), 3
  eval-patterns references, 3 agent patterns (grader, comparator, analyzer), 2
  enterprise standards, 2 drift-and-consistency references, 10 epic workflow
  diagrams.
- Epic reference documents 05-10 (6 files, ~3000 lines).
- Pattern A README with one-pager and operator-grade system analysis.

### Changed

- Audited the library for bloat: removed 9 files (975 lines) already consumed or
  belonging to the wrong product.
- Added cross-reference headers to skill-standards files.
- Mapped all library files to specific beads (43 bd update commands).

## [0.2.6] - 2026-03-24

### Added

- Epic 04 reference file (evidence layer, persistence, run lifecycle).

## [0.2.5] - 2026-03-24

### Added

- Epic 03 reference file (package integrity and deterministic checks).

## [0.2.4] - 2026-03-24

### Added

- Epic 02 reference file (spec layer and contract system).

## [0.2.3] - 2026-03-24

### Added

- Epic index and Epic 01 reference file.

## [0.2.2] - 2026-03-24

### Added

- Master build blueprint (007-PP-PLAN).

## [0.2.1] - 2026-03-24

### Fixed

- Clean up duplicate CHANGELOG entry from the release workflow.

## [0.2.0] - 2026-03-24

### Added

- Beads issue tracking integration.
- Document filing index (000-INDEX.md).

## [0.1.0] - 2026-03-24

### Added

- Initial project setup with full governance.
- README, LICENSE, CODE_OF_CONDUCT, CONTRIBUTING, SECURITY, SUPPORT.
- CI/CD workflows (lint, test, release automation).
- Enterprise documentation set (6-doc planning suite).
- GitHub issue templates and PR template.
- Dependabot configuration.
- EditorConfig and gitattributes.

[Unreleased]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.23.2...v1.0.0
[0.23.2]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.23.1...v0.23.2
[0.23.1]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.15.3...v0.16.0
[0.15.3]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.15.2...v0.15.3
[0.15.2]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.15.1...v0.15.2
[0.15.1]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.11...v0.3.0
[0.2.11]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeremylongshore/j-rig-skill-binary-eval/releases/tag/v0.1.0
