# TEST_AUDIT.md — J-Rig workspace

Updated 2026-11-10 for bead `bd_000-projects-h08j.6.5`. This replaces the
2026-07-13 counts and conclusions. Measurements below distinguish the clean
`b756df2` baseline from the workspace verification added in this change.
No numeric audit grade is assigned without a current scoring rubric.

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
The new verification regression suites add 28 tests. On the changed tree,
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
It runs in the existing CI Test job and in `pnpm run check`; its scripts,
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

## Remaining gaps

**TypeScript CRAP is incomplete.** The vendored command returned exit 0 and
`pass: true` while scoring zero production and zero test methods. That result
must not be consumed as measurement evidence. Upstream strict Python support
landed in harness PR 234, but explicitly does not measure TypeScript.
`bd_000-projects-h08j.6.7` tracks a real TypeScript complexity/coverage join;
this bead remains open until that work and consumer integration are complete.
Installing a legacy JavaScript complexity tool alone is not evidence of correct
TypeScript parsing, workspace scope or coverage joins.

The frozen toolchain currently loads Vitest 3.2.4 with coverage-v8 3.2.7
and warns that mixed versions are unsupported. `bd_000-projects-h08j.6.8`
tracks alignment and revalidation; passing baseline numbers retain this limit.

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
```

Use the JSON inventories and counting basis from the workspace commands when
interpreting their results. Re-run coverage after source changes; the historical
baseline above is not a claim about an arbitrary later checkout.
