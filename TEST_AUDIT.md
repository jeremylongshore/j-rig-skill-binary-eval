# TEST_AUDIT.md — J-Rig workspace

Local measurement dated 2026-11-24; CI integration updated 2026-11-26 for beads `bd_000-projects-h08j.6.5`,
`.6.7` and `.6.10`. Historical measurements retain their original snapshots.
Current measurements describe local, uncommitted code based on `6908b1c`,
not merged-main acceptance or an adopted harness release. No numeric audit
grade is assigned without a current scoring rubric.

## Measured baseline

The frozen install, build, `pnpm run check`, aggregate coverage and scoped
refiner-core coverage all completed successfully at `b756df2`.

| Measurement | Observed result | Enforced floor |
| --- | --- | --- |
| Vitest | 146 files; 2325 passed, 1 existing skip | Tests must pass |
| Aggregate lines / statements | 83.41% / 83.41% | 73% / 73% |
| Aggregate branches / functions | 87.51% / 91.27% | 84% / 80% |
| Refiner-core | 19 files; 428 passed | Tests must pass |
| Refiner-core lines / statements | 98.15% / 98.15% | 80% / 80% |
| Refiner-core branches / functions | 94.02% / 100% | 80% / 80% |

The 141 package test files comprise CLI 46, core 45, refiner 18,
refiner-core 19, db 5, migrate 4, pr-comment 2 and rollout-gate 2.
Two root tests and three script tests complete the baseline inventory.
`packages/dashboard` contains a placeholder README and package manifest,
not implemented dashboard behavior requiring a retrospective test waiver.
The initial verification regression suites added 28 tests. At `7af8d5f`,
`pnpm run check` and `pnpm run test:coverage` both passed: **148 files,
2353 passed and 1 existing skip**. Aggregate coverage remained **83.41% lines
and statements, 87.51% branches and 91.27% functions**. The final workspace
scan covers 148 test files and reports 57 lexical bias matches; three additional
matches arise after adding the scanner and architecture regression suites.
Architecture reports 9 packages, 203 production files and 780 import edges,
with zero violations.

## Seven-layer assessment

| Layer | Current evidence and limits |
| --- | --- |
| Hooks and CI | Husky escape scan and lint-staged; CI lint, types, tests, coverage and OTel smoke. Local hook installation is environment-dependent. |
| Static | ESLint, Prettier, strict TypeScript, CodeQL and document/workflow checks. Workspace verification scripts have a separate explicit TypeScript check. |
| Unit | Baseline tests and both coverage measurements above. Thresholds remain unchanged. Coverage measures execution, not defect detection. |
| Integration | Tests exercise cross-package behavior, real SQLite persistence, codemods and local subprocess boundaries. Stubbed provider results are not live-model evidence. |
| System | The OTel smoke executes a stub-provider evaluation and checks event contracts. It does not prove paid-provider availability or output quality. |
| End-to-end | CLI and subprocess tests cover local operator flows. No Gherkin feature corpus exists. |
| Acceptance | Historical dogfood bundles exist; they do not establish current signed publication or full requirement-to-test traceability. The platform walkthrough remains open. |

## Workspace verification

`pnpm run verify:workspace` runs repository-owned architecture checks and
inventory adapters around the unmodified vendored bias/Gherkin scanners.
It runs in the existing CI Test job and in `pnpm run check`; the CI Test job
also runs the focused verification suites and commands on Node 20.20.2 using
the declared `tsx` development runner. Its scripts,
shared inventory, tests and CI wiring are hash-pinned. This does not upgrade
the vendored harness, which remains **1.4.0**.

- **Bias:** the adapter snapshots the same three test scopes used by Vitest,
  preserving relative paths and scanning only those files in a temporary tree.
  The pre-change 146-file corpus yielded 1887 lexically recognized test
  declarations, 4741 assertion lines and 54 heuristic matches (ADVISORY).
  Parameterized tests and lexical matching explain why declaration counts differ
  from the executed-test count. Findings require review; a LOW heuristic grade
  is not proof of unbiased tests. Empty inventories, missing providers and
  malformed output fail rather than becoming a clean advisory result.
- **Gherkin:** zero tracked or non-ignored feature files yields explicit
  `NOT_APPLICABLE`, with zero discovered/scanned files. A present corpus is
  actually scanned; grammar errors fail. No empty-directory PASS is claimed.
- **Architecture:** the workspace checker inspects production TypeScript imports
  against package declarations and repository boundaries, including refiner-core
  direct I/O restrictions. Its report supplies file/import counts and violations.
  This is static checking, not a sandbox or proof of all transitive runtime behavior.

The old root-only bias command saw only 10 declarations and reported zero
matches. Its result was ADVISORY, not the PASS claimed by the previous audit.
The old architecture command was unconfigured, not a zero-violation measurement.

## Original-source coverage collection

`pnpm run test:coverage:workspace --timeout-ms 600000` discovers the full
workspace source and shared Vitest test scopes, then runs a separate collection
lane over their literal repository-relative paths. An explicit
`--inventory <inventory.json>` containing `src` and `test` arrays supports bounded
manual runs. The pending CI patch uses default discovery and retains collection
receipts as an artifact without a reduced inventory; hosted execution has not
yet been verified. Production scope is the package
`src/` trees; root tooling and build configuration are outside that production
denominator. Tests use the same three scopes as the normal Vitest run. Its public Node inspector capture and
Vitest setup/reporter hooks retain worker completion, source bytes and inline
source-map identities. It remaps observed execution to Istanbul statements,
including test callbacks, using pinned development dependencies. This does not
change the existing aggregate or refiner-core coverage floors.

The collector requires isolated fork workers and checks its execution wrapper
against both captured syntax and debugger displacement metadata. Unsupported
maps, missing workers, failed tests, changed source bytes and unobserved runtime
files produce an incomplete receipt rather than a successful coverage report.
A conservative TypeScript classifier records type-only source files separately
with their hashes; the requested inventory retains them and no coverage is
synthesized. Runtime imports, exports and value declarations cannot receive
that exclusion. Raw
captured scripts stay in private temporary staging; the public collection
receipt contains identities and counts. This is measurement integrity for a
trusted local test run, not isolation from hostile tests. Capture ends after
module teardown hooks; environment teardown and asynchronous work continuing
after module completion are outside this measurement boundary. Spawned CLI
processes are also outside the inspector sessions; the report measures Vitest
worker execution, not every process launched by the tests.

### Historical collector result

The 2026-11-10 snapshot accounted for 352 requested files: 344 observed and eight
explicitly type-only. Its 149 test files passed (2379 tests, one existing skip).
Strict measurement scored 1535 production and 3824 test functions and returned
complete **FAIL**: 29 production and nine test functions exceeded the unchanged
30/15 limits; the project average was 9.14 against a limit of 10.
Those failures are historical, not the current candidate verdict.

### Local measurement on 2026-11-24

The pending collector and evidence changes were integrated with main `6908b1c`
in a separate worktree. Newer producer hash patterns and the consolidated OTel
CI lane were preserved. A batch-lineage extraction reduced invocation setup
complexity from 31 to 25, with a separate helper complexity of 7.

The default-discovery collector returned **complete PASS**: 411 requested files,
403 observed and eight explicitly type-only. All 182 test files passed:
2805 tests passed and one existing test remained skipped. Strict measurement
scored all 1667 production and 4485 test functions, with no missing files,
duplicate paths or source-hash mismatches.

| Strict metric | Observed | Unchanged limit |
| --- | --- | --- |
| Maximum production CRAP | 29.211875 | 30 |
| Maximum test CRAP | 13.005322 | 15 |
| Project average CRAP | 1.929538 | 10 |

These scores use file-statement coverage as a function-coverage proxy. They
cover declared package production and shared Vitest tests in worker processes;
root tooling production and spawned CLI execution remain outside that scope.
The upstream scorer is read-only and external, not a vendored upgrade.

Local validation uses Node 22.23.1, pnpm 10.8.1 and TypeScript 6.0.3, with a
four-CPU quota and 4 GiB memory cap. Own offline frozen installations and a fresh
build precede measurement. The 77 focused collector, evidence and runtime-context
regressions pass. The complete instrumented Vitest run took 349.44 seconds.
The local collector deadline is 1800000 ms; the proposed hosted deadline stays
600000 ms, whose capacity has not been established by this local result.

The normal `pnpm run check` passed (182 files, 2805 tests passed and one existing
skip), including architecture verification of 229 production files and 919 import
edges with zero violations. Both native coverage gates also passed:

| Native measurement | Observed | Unchanged floor |
| --- | --- | --- |
| Aggregate statements / lines | 94.42% / 94.42% | 73% / 73% |
| Aggregate branches / functions | 88.42% / 96.32% | 84% / 80% |
| Refiner-core tests | 19 files; 428 passed | Tests must pass |
| Refiner-core statements / lines | 98.16% / 98.16% | 80% / 80% |
| Refiner-core branches / functions | 94.04% / 100% | 80% / 80% |

The measured staged tree was `5eaca4bed694f3fd209f0218f63ef81c014c3617`.
Tracked candidate bytes and external scorer hashes stayed unchanged throughout
validation. This audit text was refreshed afterward; executable source and
policy inputs retain their measured identities. The earlier held candidate
and its receipts remain preserved. No result here establishes hosted CI,
merged-main acceptance or permission to publish held changes.

### Local measurement on 2026-11-26

The completed CI adapter and its protocol regressions were validated with the
combined source tree `62c2bc5139547719e85f5c46037a30a4920fc4a5`. The normal
full check passed: 183 files, 2812 tests passed and one existing skip. Fresh
default-discovery collection accounted for 412 files: 404 observed and eight
explicitly type-only. The collector completed in 348.482 seconds under the
configured 600-second deadline on the local four-CPU/4-GiB scope.

The real immutable upstream scorer, invoked through the new adapter, returned
complete PASS: 1667 production functions and 4513 test functions scored.
Maximum production/test CRAP remained 29.211875/13.005322 and the combined
average was 1.925488 against unchanged 30/15/10 limits. Package production
source hashes still matched the earlier passing native coverage measurement.
Tracked bytes remained unchanged during code validation; this audit text and
the changelog were finalized afterward. Hosted CI is separately required before
merge; these local timings do not establish hosted capacity.

## CI strict scoring

The required Test job checks out the upstream scorer at immutable commit
`da6d67a1383ad6e573f8d02d0f14c583eaa12dc3`, separate from the vendored harness.
After fresh default-inventory collection, `pnpm run verify:crap --provider
.ci-crap-provider` supplies every literal source/test path to that provider.
The adapter checks current source hashes, coverage digest, complete file/function
denominators, unchanged 30/15/10 limits and exit/result agreement. Missing,
changed or incomplete evidence fails; a measured threshold breach also fails.
It invalidates prior scoring success before checking inputs and records provider
file hashes with the exact arguments. CI retains both coverage and strict
measurement receipts. Focused protocol tests cover passing and failing results,
stale input, omissions, zero-method success and provider failures.

The provider is a CI-only source checkout. It does not update the vendored
harness, publish a package, or change the native coverage gates. For local use,
prepare the same reviewed upstream checkout and pass its path to `--provider`.
The source pin and policy adapter are hash-pinned alongside the CI configuration.

## Remaining gaps

The vendored zero-method result remains invalid evidence; use the explicit
strict provider path above. A packaged harness release and general consumer
vendor propagation are separate work. Beads `.6.5`, `.6.7` and `.6.10` track
workspace measurement and delivery; their local/hosted receipts establish the
specific verification scope, not all platform acceptance or release integrity.

The historical baseline loaded Vitest 3.2.4 with coverage-v8 3.2.7 and
warned that mixed versions were unsupported. For `bd_000-projects-h08j.6.8`,
both are now pinned to 3.2.7. Frozen installs, fullcheck and both coverage gates
passed without the warning: 148 files, 2353 passing tests and one existing skip;
aggregate lines/statements 83.41%, branches 87.52%, functions 91.27%.
Refiner-core remains 428 passing tests, 98.15% lines/statements, 94.02% branches
and 100% functions. Coverage floors are unchanged.

Mutation testing and current requirements/persona/journey traceability remain
unverified. The classifier is unavailable through the vendored wrapper and its
registry is absent; upstream distribution repair exists, but consumer propagation
remains held. No thresholds were lowered, no vendor scripts patched, and no
harness release or automatic upgrade is included here.

## Reproduction

```bash
pnpm install --frozen-lockfile
(cd ci/emit-evidence && pnpm install --frozen-lockfile --ignore-workspace)
pnpm run build
pnpm run check
pnpm run test:coverage
pnpm run test:coverage:refiner-core
pnpm run harness:verify
pnpm run verify:workspace
pnpm run test:coverage:workspace --timeout-ms 1800000
```

Use the JSON inventories and counting basis from the workspace commands when
interpreting their results. Re-run coverage after source changes; the historical
baseline above is not a claim about an arbitrary later checkout.

For strict scoring, supply every literal path from the collection receipt as
`--source-glob` or `--test-glob` to the reviewed upstream scorer using
`--strict-measurement --lang typescript --target both --coverage-json` and the
matching coverage JSON. Keep the default 30/15/10 limits. The adapter above
assembles these arguments from the full current inventory and retains provider
identities. CI uses the immutable source checkout rather than a package release.
