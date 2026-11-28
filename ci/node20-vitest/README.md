# Node 20 compatibility checks

Root development uses matched Vitest and coverage-v8 5.0.5 on the supported Node runtimes
`^22.12.0 || ^24.0.0 || >=26.0.0`.
The existing Node 20.20.2 workspace verification lane uses this separate locked
Vitest 3.2.7/Vite 7.3.1 capsule and the same workspace regression files. It does
not change the CLI's Node 20 runtime support or replace the primary Node 22 tests.

Install with `npm ci --ignore-scripts --prefix ci/node20-vitest`. The CI step sets
`JRIG_VITEST_PROVIDER_ROOT` explicitly and invokes this capsule's runner/config.
Bare Vitest imports, including nested collection fixtures, resolve to that
selected provider. Collection evidence records its actual version plus hashes
of its package, lock and runner. The scorer recomputes those identities from the
trusted environment; a receipt cannot choose a provider. Empty configurations, changed lock bytes and incomplete measurements fail closed.
