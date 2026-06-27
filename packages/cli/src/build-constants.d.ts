// Build-time injected constants (esbuild `define` in tsup.config.ts).
//
// `__CLI_VERSION__` is replaced with the literal string value of
// packages/cli/package.json#version when the published bundle is built, so the
// `j-rig` bin reports its real release version without a runtime file read.
//
// Declared optional (`| undefined`) because the define is only applied by the
// tsup build — under `vitest`/`tsx` (no esbuild define) the identifier is not
// substituted, and index.ts falls back via `?? "0.0.0"`.
declare const __CLI_VERSION__: string | undefined;
