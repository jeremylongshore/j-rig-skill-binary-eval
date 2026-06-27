import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Resolve the bundled private packages' types INTO the emitted .d.ts so the
  // published artifact carries no `@j-rig/*` type imports (consumers can't
  // install them). Mirrors @intentsolutions/rollout-gate's dts.resolve.
  dts: { resolve: [/^@j-rig\//] },
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // BUNDLE the private workspace packages into the published artifact —
  // @j-rig/{core,db,migrate} are private:true / unpublished (the @j-rig npm
  // scope 403s). A consumer installing @intentsolutions/jrig-cli cannot pull
  // them from the registry, so they must be inlined here.
  noExternal: [/^@j-rig\//],
  external: [
    // Native addon — cannot be bundled; declared as a real runtime dependency
    // so npm rebuilds its prebuilt binary on install.
    "better-sqlite3",
    // Published on npm — kept a real dependency, not bundled (it owns the
    // `j-rig refine` subcommand and pulls @intentsolutions/refiner-core).
    "@intentsolutions/refiner",
    // Transitive npm deps of the bundled @j-rig/* packages. Declared as real
    // runtime dependencies of @intentsolutions/jrig-cli rather than inlined,
    // so they install once from the registry and dedupe across the tree.
    "@intentsolutions/core",
    "@opentelemetry/api",
    "@opentelemetry/sdk-trace-base",
    "drizzle-orm",
    "gray-matter",
    "yaml",
    "zod",
    // CLI's own direct npm deps.
    "commander",
    "chalk",
  ],
});
