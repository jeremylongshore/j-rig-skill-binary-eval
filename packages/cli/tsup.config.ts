import { createRequire } from "node:module";
import { defineConfig } from "tsup";

// Read this package's version ONCE at build time and inline it as a compile-time
// constant (esbuild `define`), so the published bin reports its real release
// version without a per-invocation runtime package.json read (no createRequire
// file I/O on every `j-rig` call). See src/index.ts → __CLI_VERSION__.
const require = createRequire(import.meta.url);
const { version } = require("./package.json") as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Compile-time version injection (findings #2 + #3): the value is baked into
  // the bundle at build, replacing the old runtime createRequire(package.json).
  define: {
    __CLI_VERSION__: JSON.stringify(version),
  },
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
