# Release Hardening — IEP Convergence Debt Plan Priority 2

**Filing**: 020-AA-AACR-release-hardening-iep-P2-2026-05-21.md
**Date**: 2026-05-21
**Author**: Jeremy Longshore (CTO + beads work; executed by Claude per CEO-mode delegation)
**Beads closed (pending PR merge)**:

- `iaj-release-test-bypass` (`bd_000-projects-d8au`, P0) — remove `|| true` from `.github/workflows/release.yml`
- `iaj-stub-provider` (`bd_000-projects-lcgu`, P0) — make stub providers loudly non-authoritative + gated by explicit opt-in

**Cluster**: IEP Convergence Debt Plan Priority 2 (`iep-P2-j-rig-hardening`, `bd_000-projects-sqq8`)

---

## 1. What this AAR records

Two parallel risks closed:

1. **`release.yml` masked test failures** with `|| true` on every test runner invocation. A red test suite could ship a tagged release with green CI signals. Fixed by removing the suffixes.
2. **Stub providers ran by default** in `j-rig eval`. Every invocation produced synthetic ship verdicts that looked indistinguishable from real ones. Fixed by requiring explicit opt-in (`J_RIG_ALLOW_STUB=1`) plus a loud stderr banner on every stub-mode invocation, backed by negative tests.

## 2. What changed

| File                                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/release.yml`                      | Removed `\|\| true` from the 5 test-runner branches (Makefile/test, pnpm test, pytest, cargo test, go test). Failing tests now block releases. Added a `::warning::` line for the "no test runner detected" fallback to discourage silent no-test releases.                                                                                                                                                                                       |
| `packages/cli/src/providers/anthropic.ts`            | NEW exported `emitStubBanner()` (writes a multi-line warning to stderr, idempotent per process); NEW exported `assertStubAllowed()` (throws unless `J_RIG_ALLOW_STUB=1` is set); NEW exported `__resetStubBannerForTests()` (test-only reset hook); all 3 stub class constructors call `emitStubBanner()`.                                                                                                                                        |
| `packages/cli/src/commands/eval.ts`                  | Imports `assertStubAllowed`; calls it at the very top of the action handler before any stub instantiation. The CLI now REFUSES to run without `J_RIG_ALLOW_STUB=1` with a clear error message pointing to `STUB-PROVIDERS.md`.                                                                                                                                                                                                                    |
| `STUB-PROVIDERS.md` (NEW, repo root)                 | Discipline + risk notice: what "stub provider" means, why this is dangerous if treated as ground truth, the four discipline rules (opt-in mandatory, loud banner, CI-gate refuse stub-mode artifacts, backward-compat carve-out for non-provider commands), how to acknowledge stub mode, and what changes when the real Anthropic adapter lands.                                                                                                 |
| `README.md`                                          | NEW subsection `### ⚠️ Stub providers — output is NOT ground truth` under `### Current Status` cross-references `STUB-PROVIDERS.md`.                                                                                                                                                                                                                                                                                                              |
| `packages/cli/src/providers/anthropic.test.ts` (NEW) | 10 negative tests prove the two invariants: (a) `assertStubAllowed` refuses everything except `J_RIG_ALLOW_STUB=1` (the empty string, `"true"`, `"yes"`, `"0"`, all rejected); (b) the banner emits to stderr exactly once per process even after multiple stub class constructions, contains the required strings (`WARNING`, `STUB PROVIDER MODE`, `NOT ground truth`, `J_RIG_ALLOW_STUB=1`, `STUB-PROVIDERS.md`), and does not pollute stdout. |
| THIS AAR                                             | Closeout.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 3. Verification

- `pnpm --filter @j-rig/cli run typecheck`: clean.
- `pnpm exec vitest run` (full j-rig suite): **30 test files passed, 356/356 tests passed**, including the 10 new stub-mode tests. No regressions.
- `bash scripts/audit-harness escape-scan --staged`: `REFUSE=0 CHALLENGE=0 FLAG=0`.
- Local manual reproduction of the opt-in refusal: invoking the eval handler without `J_RIG_ALLOW_STUB=1` throws the documented `REFUSED:` error; with `J_RIG_ALLOW_STUB=1` set, the banner prints to stderr exactly once and execution proceeds.

## 4. Scope discipline

### What's IN this PR

The four items the IEP Convergence Debt Plan Priority 2 § "Specific fixes" listed:

1. Remove `|| true` from `release.yml`
2. Stub providers loudly non-authoritative (banner + opt-in gate)
3. `STUB-PROVIDERS.md` at repo root
4. CI negative test proving stub vs production-mode behavior

### What's deferred (NOT in this PR)

- **`provider.mode: "stub"` field on emitted EvidenceBundle rows.** Per DR 018 § 6.4 Option α-minus, j-rig's local EvidenceBundle schema migrates to kernel-canonical when `iec-E12` ships and `iaj-E02b` lands. Adding a `provider.mode` field to j-rig's local schema now would deepen the kernel divergence DR 018 just ratified resolving. Field marker lands as part of `iaj-E02b` per DR 018 § 9.2. j-rig's `eval` command does not currently emit Evidence Bundle rows directly (only `emit-evidence` does, and that consumes input via stdin/`--input`), so the operational risk in this PR's scope is fully addressed by the banner + opt-in gate.
- **Real Anthropic SDK adapter implementation** (PB-7). That work is the full scope of `iaj-stub-provider` going forward — until then, stubs ARE the entire provider surface. This PR closes the "stubs run silently as default" risk; PB-7 closes the "no real provider exists at all" gap.

## 5. Risk + open questions

- **CI workflows that invoke `j-rig eval` MUST set `J_RIG_ALLOW_STUB=1` explicitly** until the real adapter lands. Otherwise CI will fail with the `REFUSED` error. This is the intended behavior — the opt-in is the audit trail. Existing workflows that previously assumed `j-rig eval` "just worked" need to add the env var to their YAML.
- **The opt-in env-var name is intentionally specific** (`J_RIG_ALLOW_STUB`, not `J_RIG_ENV=dev` or `NODE_ENV=test`). Resisted the temptation to overload existing env vars because the discipline benefits from a single-purpose name that grep can find in CI configs.
- **Banner formatting** uses Unicode box-drawing characters. Most modern terminals + GitHub Actions log viewers render them correctly. The banner remains legible even in plain ASCII rendering because the content is in regular characters; the box is decorative.

## 6. References

- IEP Convergence Debt Plan Priority 2 — local plan reference (2026-05-20 enhanced 2026-05-21)
- DR 018 (ISEDC Session 5) — `intent-eval-lab/000-docs/018-AT-DECR-isedc-council-session-5-jrig-reconciliation-2026-05-21.md`
- Bead lineage:
  - `bd_000-projects-d8au` — `iaj-release-test-bypass` (P0) — fully resolved by this PR
  - `bd_000-projects-lcgu` — `iaj-stub-provider` (P0) — opt-in + banner discipline resolved by this PR; the real Anthropic adapter implementation (PB-7) is a separate scope continuing under the same bead
  - `bd_000-projects-sqq8` — `iep-P2-j-rig-hardening` (P0 umbrella)
- Implementation: `packages/cli/src/providers/anthropic.ts` (`emitStubBanner`, `assertStubAllowed`) + `packages/cli/src/commands/eval.ts` (action-handler entrypoint check)
- Discipline doc: `STUB-PROVIDERS.md` at repo root
- Negative tests: `packages/cli/src/providers/anthropic.test.ts`

— Jeremy Longshore
intentsolutions.io
