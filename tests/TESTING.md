# Testing observations — J-Rig

Source `e3119f41ffce449844c6320b3d97eef777a9ba20`, audited 2026-10-19 for bead `bd_000-projects-0s9t`.
No engineer-owned policy section, threshold, waiver or requirement priority is
created or changed by this observational record.

## Classification (observational)

Nine-package TypeScript/pnpm workspace: two CLI surfaces, libraries and a
manifest-only dashboard placeholder. Manual classification is provisional:
vendored audit-harness 1.4.0 lacks the registry needed to emit `audit-profile/v1`.
There are no engineer-declared waived layers in this file.

## Installed gates (observational)

- L1: Husky staged escape scan/lint-staged; PR CI and protected main.
- L2: ESLint, Prettier, strict TypeScript, Markdown/YAML/actions/spelling checks;
  CodeQL runs separately. No tracked CI invocation of secret/dependency scanners.
- L3: 123 Vitest files; 1924 passed, one conditional inapplicable skip. Global
  V8 coverage passes the existing 73/73/80/84 statement/line/function/branch
  floors in [vitest.config.ts](../vitest.config.ts). Refiner Core's separate
  80% floors pass. Mutation absent; architecture unconfigured; CRAP unmeasured.
- L4/L6: real SQLite, cross-package/kernel contracts, built CLI/local process
  and loopback HTTP tests. Gherkin absent; that does not imply absent CLI E2E.
- L5: security regression tests and CodeQL; Node 22 is the measured runtime.
- L7: scoped observational [RTM](RTM.md), [personas](PERSONAS.md),
  [journeys](JOURNEYS.md); human UAT is not inferred from automation.

## Frameworks (observational)

Node 22.23.1, pnpm 10.8.1, Vitest 3.2.4, V8 coverage, TypeScript 6.0.3.
Vendored audit-harness 1.4.0; registry latest observed 1.5.1 on 2026-10-19.
Baseline hash verification passes for 24 original pinned files; this new
observational file is initialized as the 25th pin in the implementation handoff. The inherited policy lives in
tracked configs and their existing hash manifest; this file does not replace it.

## Last audit (observational)

2026-10-19: [TEST_AUDIT.md](../TEST_AUDIT.md). Build, lint, types and both coverage
commands pass. Grade withheld because complexity, mutation and architecture
measurements are missing and no authoritative numeric scoring formula exists.
P1 gaps are handed to `bd_000-projects-ehyd`; upstream TypeScript measurement
also relates to `bd_000-projects-0wvb`. No clean-audit claim.

## Traceability (observational)

35 selected inferred-SHOULD requirements: 26 locally covered, seven partial,
two locally unverified. 53 of 123 test files have explicit sidecar associations;
70 are not mapped in this scoped catalog, not proven orphaned. Four inferred
roles/12 selected flows; five inferred journeys/23 steps. No declared persona or
journey threshold is installed. Per-package observations live at
`packages/<name>/tests/TESTING.md`.
