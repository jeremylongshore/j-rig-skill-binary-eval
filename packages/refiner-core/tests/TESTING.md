# Testing observations — @intentsolutions/refiner-core

Source `e3119f41ffce449844c6320b3d97eef777a9ba20`, audited 2026-10-19 for bead `bd_000-projects-0s9t`.
These are observations, not new engineer policy or waivers.

## Classification (observational)

Manual role: pure decision library in the nine-package pnpm workspace. The installed
harness cannot emit its deterministic profile because its registry is missing.
See the [root audit](../../../TEST_AUDIT.md) for that limitation.

## Installed gates (observational)

14 package `src/**/*.test.ts` files are included by the root Vitest configuration.
Root CI builds and tests this package in the aggregate suite. The per-package counters in the root audit are observations; only Refiner Core has a separately enforced package coverage floor.

## Frameworks (observational)

Vitest 3.2.4 and V8 coverage; shared strict TypeScript, ESLint and Prettier.
No package mutation, architecture or generated property-test gate is configured
at the audited source. Inherited configuration remains authoritative.

## Last audit (observational)

2026-10-19: see [TEST_AUDIT.md](../../../TEST_AUDIT.md) for measured counts,
coverage, exclusions, gaps, and the implementation handoff. No numeric quality
grade is inferred from passing tests alone.

## Traceability (observational)

[RTM](../../../tests/RTM.md), [personas](../../../tests/PERSONAS.md) and
[journeys](../../../tests/JOURNEYS.md) are scoped sidecar mappings, not exhaustive
acceptance policy. [Root testing observations](../../../tests/TESTING.md) describe
shared enforcement.
