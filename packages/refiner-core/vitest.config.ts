import { defineConfig } from "vitest/config";

/**
 * Per-package coverage gate for @j-rig/refiner-core (bd_000-projects-214c.4 /
 * Plan 027 § 4 Phase A exit criteria).
 *
 * The root vitest.config.ts measures coverage across ALL workspace packages and
 * enforces a SINGLE global floor. That root floor cannot, on its own, fail a PR
 * for a refiner-core-specific regression: a drop inside refiner-core can be
 * masked by gains elsewhere or simply diluted across the much larger global line
 * count. This scoped config exists to fail the PR the moment refiner-core
 * coverage drops below its own dedicated floor, INDEPENDENT of the rest of the
 * monorepo. refiner-core is the durable Skill Refiner contribution (AC-7), so it
 * earns a dedicated gate.
 *
 * Run via `pnpm run test:coverage:refiner-core` (wired into ci.yml as its own
 * step). `include` is narrowed to refiner-core sources only, so the thresholds
 * below are evaluated against THIS package's executable code, not the global
 * union.
 *
 * Floor discipline: the bead's stated gate is >= 80% on every dimension. The
 * floors below are set at that bead-mandated 80% — NOT at the measured baseline.
 * Measured 2026-06-20 baseline (scoped run): 96.64% lines/statements, 90.83%
 * branches, 100% functions. The 80% floor sits well below the current value, so
 * CI is green today and a refiner-core regression below the AC-7 bar reds CI,
 * while leaving headroom for benign refactors that shift a branch without
 * dropping real coverage. autoUpdate stays false so a green run can never
 * silently rewrite the floor downward. Raise these numbers if the team chooses a
 * tighter ratchet; never lower them below 80%.
 *
 * Type-only modules (`types.ts` in src/ and src/strategies/, plus the barrel
 * `index.ts`) carry no executable lines and are excluded exactly as the root
 * config excludes `index.ts`, so they neither inflate nor deflate the gate.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["packages/refiner-core/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      include: ["packages/refiner-core/src/**/*.ts"],
      exclude: [
        "packages/refiner-core/src/**/*.test.ts",
        "packages/refiner-core/src/**/*.spec.ts",
        "packages/refiner-core/src/**/index.ts",
        "packages/refiner-core/src/types.ts",
        "packages/refiner-core/src/strategies/types.ts",
        "packages/refiner-core/dist/**",
      ],
      thresholds: {
        autoUpdate: false,
        // bd_000-projects-214c.4: the bead floor is >= 80% on every dimension.
        // Current measured (2026-06-20, scoped): 96.64% lines/statements,
        // 90.83% branches, 100% functions — comfortably above this floor.
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
