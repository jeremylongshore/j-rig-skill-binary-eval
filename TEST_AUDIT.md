# J-Rig test audit — 2026-10-19

Audited source: `e3119f41ffce449844c6320b3d97eef777a9ba20`. Scope: all nine workspace
packages plus root tests, scripts, hooks and tracked CI. Bead
`bd_000-projects-0s9t`; implementation handoff: `bd_000-projects-ehyd`.
This replaces the July diagnostic; Git history retains that earlier observation.

## Result and grade

**Existing build, lint, types and coverage gates pass; the audit has unresolved
P1 gaps.** The suite collected 123 files and 1925 cases: **1924 passed and one
conditionally inapplicable case skipped**. The skipped MCP observation-overhead
case is duplicated over observations off/on and runs when observations are on
([mcp-runtime.test.ts](packages/cli/src/execution/mcp-runtime.test.ts), line 111).

**Letter/numeric grade: not assigned.** No authoritative numeric grading formula
exists, and mutation, complexity and architecture are unmeasured. A fabricated
aggregate score would obscure those gaps. No P0 defect is established by the
measured suite; gap priorities below are provisional because the installed
classifier cannot produce its deterministic gate profile. This is not a safety
certification or proof of complete requirement coverage.

## Freshness and classification

The repository vendors audit-harness **1.4.0**; npm's latest version was **1.5.1**
on 2026-10-19. Baseline hash verification succeeds (24 pinned files). However:

- `scripts/audit-harness classify` exits 2: the shell wrapper has no such verb.
- `node .audit-harness/bin/audit-harness.js classify` exits 2 because
  `schemas/audit-profile/registry.v1.json` is absent from the installation.
- The Node `conform`, `audit --deep`, and `scan` commands fail at that same
  missing registry; `currency` exits 2 because its pins file is absent.

Thus no `audit-profile/v1` or successful gate-result bundle is claimed.
Manual source inspection identifies a **monorepo of CLI and library packages**;
the dashboard has only a placeholder manifest, not an implemented UI requiring
browser acceptance tests. No regulated overlay or engineer-declared waivers were
found. Per-package observations below are not replacement policy.

The supported v1.5.1 installer at commit
`0a6d6e0e76b7f76bcc5bcfd2b7c7cf8ab75e405f` copies the missing schemas and adds
shell `classify`/`conform` dispatch. That is an implementation route, not an
upgrade performed by this audit. Its legacy CRAP scorer still needs additional
TypeScript/monorepo work; upgrading alone will not prove complexity coverage.

## Measurements and reproducibility

Environment: Node 22.23.1, pnpm 10.8.1, Vitest 3.2.4, TypeScript 6.0.3, Linux.
Dependencies installed from the frozen lockfile; no hosted provider run was
started. Existing tests use injected transports, fixtures, SQLite and local
processes/HTTP. The audited runtime source and all 24 original policy-file hashes are unchanged.

| Command | Exit/result | Scope and interpretation |
| --- | --- | --- |
| `pnpm run build` | 0 | All implemented workspace builds. |
| `pnpm run lint` | 0 | Repository ESLint. |
| `pnpm run typecheck` | 0 | Root tests and package TypeScript. |
| `pnpm run test:coverage` | 0; 123 files, 1924 passed, one skip | Aggregate current-config coverage, 139.99 seconds. |
| `pnpm run test:coverage:refiner-core --coverage.reportsDirectory=/tmp/0s9t-refiner-coverage` | 0; 14 files, 332 passed | Separate configured package gate. |
| `scripts/audit-harness verify --json` | 0; 24 baseline pins | Integrity of existing protected files, not proof every desired gate is installed. |
| `scripts/audit-harness arch` | 2; not-configured | No architecture rules measured; zero violations is not a pass. |
| `scripts/audit-harness crap --target both --out /tmp/0s9t-crap` | 0, but zero production and test methods scored | Missing complexity-report; root-only source traversal. Reported pass is vacuous. |
| `scripts/audit-harness bias` | 0; root tests only | Ten regex-counted functions, 24 assertions, zero matches; not the workspace suite. |
| `scripts/audit-harness bias packages` | 0; 213 heuristic matches | Recurses into non-test and generated files; not 213 proven weak tests. |
| `scripts/audit-harness gherkin-lint` | 2; features directory absent | No BDD pack. Existing CLI E2E remains real evidence. |
| Mutation runner | Not run: absent | No configuration/dependency or kill-rate evidence. |

Aggregate V8 totals: **15,807/19,310 lines and statements (81.85%),
4,400/5,050 branches (87.12%), 799/883 functions (90.48%)**. Existing floors
remain 73% lines/statements, 84% branches and 80% functions. The separate
Refiner Core run reports **1,274/1,310 lines/statements (97.25%), 443/486 branches
(91.15%), 87/87 functions (100%)**, above its existing 80% floors in all dimensions.

Coverage is limited by the existing configs: root coverage includes package
TypeScript but excludes tests, index files, dist and fixtures. Root scripts are
not in that production coverage denominator. Package counters below aggregate
the root JSON file counters, rounded to two decimals; the separate Refiner Core
config has a different instrumented scope. Global coverage can hide weak package
coverage: the CLI has 68.24% line coverage without violating the global policy.
No per-package floor is invented for it.

| Package | Manual role | Test files | Lines | Branches | Functions |
| --- | --- | --- | --- | --- | --- |
| cli | CLI | 40 | 5970/8748 (68.24%) | 1838/2090 (87.94%) | 314/376 (83.51%) |
| core | library | 45 | 6062/6572 (92.24%) | 1407/1660 (84.76%) | 247/262 (94.27%) |
| dashboard | manifest-only placeholder | 0 | — | — | — |
| db | SQLite library | 5 | 822/840 (97.86%) | 151/175 (86.29%) | 42/44 (95.45%) |
| migrate | codemod library | 4 | 259/261 (99.23%) | 91/96 (94.79%) | 15/15 (100.00%) |
| pr-comment | pure rendering library | 2 | 148/155 (95.48%) | 70/73 (95.89%) | 15/15 (100.00%) |
| refiner | CLI/orchestration library | 6 | 1088/1240 (87.74%) | 337/405 (83.21%) | 73/78 (93.59%) |
| refiner-core | pure decision library | 14 | 1276/1312 (97.26%) | 444/487 (91.17%) | 88/88 (100.00%) |
| rollout-gate | decision library | 2 | 182/182 (100.00%) | 62/64 (96.88%) | 5/5 (100.00%) |

The package test files total 118; root tests add two and scripts add three.
Dashboard has no instrumented source denominator. Only Refiner Core has a
separately enforced package coverage floor.

## Seven-layer presence and enforcement

| Layer | Observation | Evidence and limits |
| --- | --- | --- |
| L1 hooks/CI | Installed | `.husky/pre-commit` runs staged escape scan and lint-staged; CI runs on PRs. Protection and local merge guard explicitly list eight checks. |
| L2 static | Partial | ESLint, Prettier, strict types, Markdown/YAML/actions/typos checks run. No secret or dependency-vulnerability scanner invocation was found in tracked workflows. This is not a claim about external GitHub security settings. |
| L3 unit/function | Partial | Both coverage gates pass; no mutation or generated property/fuzz framework; architecture unconfigured and CRAP unmeasured. |
| L4 integration/contracts | Installed | Real SQLite lifecycle and raw-run/grade persistence; cross-package rollout/comment tests; kernel EvidenceStatement and migration round-trip contracts. |
| L5 system quality | Partial | CodeQL and CISO regression tests exist. Main CI tests Node 22 despite published Node >=20 support; the other supported versions are not verified by this run. |
| L6 E2E/smoke | Installed for local CLI boundaries | Built CLI tests exercise eval, budgets, MCP and provider-failure behavior; OTel smoke is a distinct workflow job. Root arithmetic smoke alone is not application coverage. No Gherkin pack. |
| L7 acceptance | Scoped observations only | RTM/persona/journey mappings below. Unit tests and synthetic eval output do not establish human acceptance or production promotion. |

GitHub protection was read from the canonical
`jeremylongshore/j-rig-skill-binary-eval` repository. Its explicit required
contexts are `Lint`, `Test`, `Typecheck`, `yamllint`, `actionlint`,
`markdownlint-cli2`, `lychee`, and `typos`; the local safe-merge configuration
lists the same eight. Strict up-to-date-branch checking is false. The active
ruleset requires a PR and forbids non-fast-forward updates/deletion, with zero
required approving reviews. Administrative bypass exists; none was used here.
CodeQL and OTel jobs run but are absent from those explicit required-context
lists. Repository guidance separately names CodeQL as a merge gate. This audit
records the difference and does not change protection or weaken that guidance.

## Test-quality caveats

The bias scanner's recursive grep does not restrict itself to test source.
Its Python-style quote/space/`in` pattern flags legitimate JavaScript field-absence checks
in `packages/migrate/src/transform.test.ts`; production length comparisons also
match its patterns. `toBeDefined` in `packages/refiner/src/propose.test.ts` is
accompanied by exact transport, API-key and output assertions. Those examples
are false positives for a weak-test defect. The reported 11.9 matches per 100
regex-counted functions is a review heuristic, not a measured defect rate.

The CRAP implementation returns empty results when complexity-report is absent
and selects only root `src` or `tests`. Installing that tool alone would still
omit package source. Its production/test method counts are both zero, so max/mean
zero cannot certify the configured complexity thresholds. The upstream
measurement work is already tracked in `bd_000-projects-0wvb`.

## Traceability and acceptance scope

[RTM](tests/RTM.md) maps **35 selected requirements**: 26 locally covered,
seven partial, two unverified within the local test inventory. All priorities
are inferred SHOULD pending engineer review; source obligations remain intact.
53 of 123 test files have explicit sidecar associations. The other 70 are
**unmapped in this scoped catalog**, not proven orphans. Exhaustive historical
requirements and orphan totals remain undetermined.

[PERSONAS](tests/PERSONAS.md) records four inferred roles and 12 selected flows;
11 have local evidence and one is the dashboard placeholder.
[JOURNEYS](tests/JOURNEYS.md) records five inferred journeys with 23 steps:
12 local, six partial, four locally unverified, one placeholder. No persona or
journey threshold was declared or installed. These mappings distinguish fixture
signatures, unsigned reports and disconnected seams from actual signing,
publication, external ingestion and human decisions. Absence from this local
test catalog does not invalidate operational evidence maintained by other beads.

## Gaps and implementation handoff

The audit is diagnostic. No existing thresholds, runtime behavior, workflows,
architecture rules or original protected-file hashes were changed. New testing
documents contain observations only. The implementation handoff initializes one
additional hash entry for the new root `tests/TESTING.md`, which the installed
harness automatically treats as a protected filename. The following P1 work is handed to `bd_000-projects-ehyd`
through the implement-tests workflow:

| ID | Priority | Gap | Required completion evidence |
| --- | --- | --- | --- |
| G1 | P1 | Incomplete vendored harness blocks deterministic profiles and dimension reports. | Supported complete install; classify every package; rerun conform/audit/scan/currency with explicit statuses and unchanged original policy. |
| G2 | P1 | No mutation measurement for implemented decision logic. | Configured Stryker run, retained killed/survived/uncovered/error counts, meaningful survivor review, CI evidence; no invented or lowered blocking floor. |
| G3 | P1 | CRAP has zero methods and excludes workspace source. | TypeScript-capable source inventory joined to actual execution coverage, nonempty production/test measurement, explicit unsupported cases and fail-closed missing-tool proof; coordinate upstream `0wvb`. |
| G4 | P1 | No tracked secret/dependency scan workflow gate. | Reproducible scanner outputs and CI wiring with synthetic fault checks; retain existing advisory vulnerabilities honestly. New harness gate promotion follows its false-positive and engineer-policy requirements. |
| G5 | P1 | No architecture measurement. | Rules derived from authored package boundaries, reviewed policy ownership, actual dependency graph and injected-violation proof. No blanket invented dependency rule or repinning to silence a failure. |
| G6 | P1 | No generated property-based tests for core invariants. | Bounded generators exercise authored acceptance/apply/evidence invariants with reproducible seeds and nontrivial failure cases. |

P2 observations: explicit CodeQL/OTel required-context mismatch; unmeasured
Node compatibility range; uneven package-level coverage; incomplete local
traceability for continuous live refinement, human review and external release
flows. The dashboard is an explicit placeholder, not an implemented untested UI.
No automatically generated waiver closes any of these findings.

Implementation order: repair supported harness installation and obtain the
profile; preserve existing policy and inspect unresolved applicability; add
measurements and advisory evidence; then perform any policy promotion only with
the required evidence and ownership. The upstream TypeScript measurement gap
must not be hidden behind an unrelated passing Python measurement.

## Containment and delivery

Adding `tests/TESTING.md` initially caused an inventory-mismatch REFUSE.
Review confirmed that all 24 existing protected-file hashes were unchanged.
The implementation handoff initializes the new observation-only file as the
25th pin; no manifest entry is removed or replaced. Final staged escape
scanning passes with zero REFUSE, CHALLENGE or FLAG findings.

The escape scanner reports its fallback comparison floors (80% line, 70% branch,
70% mutation) because this observational file declares no new threshold policy.
Those fallback values also applied before this file existed; they are not the
configured Vitest floors or an adopted mutation policy. The existing coverage
configs and unchanged hash protections remain authoritative. The implementation
handoff must reconcile this policy-source mismatch explicitly. Raw measurement
logs and JSON remain in the task's local receipt bundle. The final PR and Beads
closure record carry exact-head CI and merge evidence. Report generation does
not itself establish that every handoff gap is fixed.
