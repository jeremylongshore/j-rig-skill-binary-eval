# Canonical Dashboard Evidence

J-Rig has two independent dashboard producers. `scripts/emit-evidence.ts`
publishes release coverage as `iaj` using the workspace kernel 0.11.0 and a
`refs/tags/v*` signing identity. `ci/emit-evidence/emit-evidence.ts` publishes
real nightly roster results as `jrig`, using standalone kernel 0.10.0 and the
existing main-only nightly identity. Neither emitter changes the CLI's own
statement output, provider behavior, verdicts or publication triggers.

## Payload Contract

Each measured gate result is wrapped in a kernel-validated in-toto statement
array. `storage_key` hashes the complete canonical array; subjects, predicate
types and row count derive from that payload. Manifest assembly validates these
bindings and the `gateResults` projection before transporting the signature.
Cosign and dashboard ingest perform real signature verification separately.

The shared unsigned fixture comes from
[marketplace commit 0d6ff1b](https://github.com/jeremylongshore/tons-of-skills-marketplace/blob/0d6ff1b7183c1cf4603187fc861c46466603e1b9/ci/emit-evidence/canonical-payload.fixture.json),
also consumed by dashboard PR104. Its SHA256 is
`b5f9bf3ff6519f364e458b98268c75802a5737b90cc699e4f7d04866184afe12`.
Emitter sources, fixture, tests and standalone kernel pin are hash-protected.

## Local and CI Checks

Use Node 22.6 or newer. Install both frozen dependency graphs:

```bash
pnpm install --frozen-lockfile
(cd ci/emit-evidence && pnpm install --frozen-lockfile --ignore-workspace)
pnpm exec vitest run scripts/canonical-payload.test.ts
pnpm run build && pnpm run check
pnpm run harness:verify
```

The 24 contracts cover both installed kernel versions, the shared canonical
bytes, pass/fail/advisory/error preservation, source identities, payload and
metadata mutations, missing payloads, divergent projections and missing
signature files. PR CI and both signing workflows run them. Fixtures are
synthetic and unsigned; they establish no live measurement or signature proof.

## Live Transition

After a reviewed source merge, `iaj` still needs an approved repository release;
`jrig` needs a successful real nightly run. Record each published source SHA,
manifest digest, signature result, dashboard ingest and rendered rows under
`bd_000-projects-0s2a`. A CLI-only release is not an `iaj` publication.
Never sign synthetic test outcomes or republish stale roster outputs as fresh
measurements. Retain dashboard legacy compatibility until every producer and
retained cache has a verified transition disposition.
