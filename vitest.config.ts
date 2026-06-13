import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/*/src/**/*.spec.ts",
        "packages/*/src/**/index.ts",
        "packages/*/dist/**",
        "**/__fixtures__/**",
      ],
      // Ratchet-from-here coverage floor. These thresholds are the measured
      // 2026-06-12 baseline ROUNDED DOWN to the nearest whole percent, so CI is
      // green today and the suite can only ratchet UP from here — never regress.
      // Unlike @intentsolutions/core (100% by construction), j-rig earns its
      // floor empirically and raises it over time. Raise these numbers when the
      // suite improves; never lower them. autoUpdate stays false so a green run
      // can never silently rewrite the floor downward.
      thresholds: {
        autoUpdate: false,
        lines: 73,
        statements: 73,
        functions: 80,
        branches: 84,
      },
    },
  },
});
