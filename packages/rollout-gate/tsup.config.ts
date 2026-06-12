import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { resolve: ["@j-rig/core"] },
  clean: true,
  // Bundle the PRIVATE workspace dep into the published artifact —
  // consumers cannot install @j-rig/core from npm. zod stays external.
  noExternal: ["@j-rig/core"],
  external: ["zod"],
});
