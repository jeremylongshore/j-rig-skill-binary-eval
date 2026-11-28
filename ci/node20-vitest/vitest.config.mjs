import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const caller = createRequire(import.meta.url);
export default defineConfig({
  root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  resolve: {
    alias: [
      {
        find: /^vitest$/,
        replacement: resolve(dirname(caller.resolve("vitest/package.json")), "dist/index.js"),
      },
    ],
  },
  test: {
    globals: true,
    maxWorkers: 2,
    minWorkers: 1,
    include: [
      "scripts/workspace-architecture.test.ts",
      "scripts/workspace-quality.test.ts",
      "scripts/workspace-coverage*.test.ts",
      "scripts/workspace-crap.test.ts",
    ],
  },
});
