import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.mjs",
            // Plain-JS CI driver — standalone, outside any tsconfig project.
            "eval-roster/*.mjs",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Plain-JS Node script (no build step) — give it the Node globals the
    // typed packages get from @types/node.
    files: ["eval-roster/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
  {
    ignores: [
      "dist/",
      "packages/*/dist/",
      "coverage/",
      "node_modules/",
      "000-docs/",
      "eval-packs/",
    ],
  },
);
