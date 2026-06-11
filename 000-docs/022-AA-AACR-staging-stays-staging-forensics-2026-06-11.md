# Staging-Stays-Staging Forensics — j-rig production-Rekor Promotion Audit

**Filing**: 022-AA-AACR-staging-stays-staging-forensics-2026-06-11.md
**Date**: 2026-06-11
**Author**: Jeremy Longshore (CISO carve-out forensics; executed by Claude)
**Bead**: `iaj-staging-stays-staging-aar` (forensics + AAR)
**Binding source**: DR-018 § 6.2 Q1(b) CISO carve-out (`intent-eval-lab/000-docs/018-AT-DECR-isedc-council-session-5-jrig-reconciliation-2026-05-21.md`)
**Cluster**: IEP Convergence Debt Plan Priority 1 — kernel adoption (`iep-P1-kernel-adoption`)
**Result**: ✅ PASS — ZERO production-Rekor promotions found (expected count: zero)

---

## 1. What this AAR records

DR-018 § 6.2 (Q1(b), "Existing v0.1.0-draft-shape attestations: re-emit vs
staging-stays-staging") settled **STAGING-STAYS-STAGING** as the binding posture:
existing `sigstore_staging` j-rig rows age out per Rekor's normal retention; **no
re-emission**. New j-rig v2.0+ attestations conform to the kernel's normative
`gate-result/v1` shape (Blueprint B § 7.4) and are eligible for production-Rekor
promotion only after the per-predicate gate (SPEC.md normative + DNSSEC + CAA
verified for `evals.intentsolutions.io`) clears.

That decision carries a **binding CISO carve-out**:

> "if forensics finds any j-rig rows that were promoted from `sigstore_staging`
> to production-Rekor before this DR (expected count: zero), those rows get
> re-emitted under the new shape AND the old rows get a Rekor-recorded
> supersession entry. Production-Rekor rows are permanent; the platform cannot
> leave a non-conformant production row standing. **The forensics check is a
> pre-merge gate on the j-rig v2.0.0 PR.**"

This document is that forensics check, run ahead of the j-rig kernel-migration
work (bead `iaj-E02`). It records the search performed, the evidence, and the
release-note language the v2.0.0 cut must carry.

## 2. Forensics scope and method

The question is narrow and binary: **did any j-rig evidence row ever get
promoted from `sigstore_staging` to production-Rekor before DR-018?** The
expected (and architecturally-mandated) answer is zero, because:

- j-rig is at **v1.1.0** (staging-tier). No v2.0.0 has been cut — v2.0.0 is the
  version that introduces the normative predicate shape and the only version
  eligible for production-Rekor promotion (and only after the per-predicate
  DNSSEC + CAA + SPEC.md gate clears, which has not happened).
- The `signing_mode` field on the kernel `EvidenceBundle`
  (`sigstore_staging | rekor_production | unsigned_experimental`) is the
  structural mechanism that encodes this distinction (DR-018 § 6.2 rationale).

### 2.1 Searches performed

| # | Search | Result |
| - | ------ | ------ |
| 1 | `grep -rIn -E "rekor_production\|production[_-]?rekor\|signing_mode\|sigstore_staging\|promoted\|promotion\|supersession"` across `*.ts`/`*.json`/`*.md`/`*.yaml`/`*.sql` (excluding `node_modules/`, `dist/`, `.audit-harness/`) | 3 source hits + 1 gitignored build artifact (see § 3) |
| 2 | `git ls-files build/` — any **tracked** evidence bundle bytes | none |
| 3 | `git log --oneline --all -- 'build/evidence/*'` — any commit that ever touched an evidence row | none |
| 4 | `git ls-files \| grep -iE "\.db$\|\.sqlite\|\.jsonl$\|evidence.*\.json$\|rekor"` — any tracked DB / persisted evidence / Rekor record | only `.beads/issues.jsonl` (bead tracking, not evidence) |
| 5 | `grep -rIn -E "rekor\|signing_mode\|production\|staging\|sigstore" packages/db/src` — DB-layer persistence of signing state | none |
| 6 | `git tag --list` — any `v2.0.0+` tag (the only promotion-eligible lineage) | none; highest released lineage is v1.x |

### 2.2 The three source hits, classified

1. **`scripts/emit-evidence.ts:208`** — `signing_mode: 'rekor_production'` is the
   *claimed* mode written into the **canonical bundle bytes that CI signs**, not a
   record of a completed promotion. The script header (lines 23–24) is explicit:
   *"This script does NO crypto and writes only to the gitignored `build/` dir."*
   The real Rekor index lives in the sigstore Bundle's inclusion proof produced
   downstream in CI (`scripts/emit-evidence.ts:52–54`), not in any committed
   artifact. This is forward-looking emit plumbing (bead nr75.11 dashboard
   reports-hub), not historical promotion state.
2. **`scripts/emit-evidence.ts:52`** — the same claim, in a doc comment.
3. **`000-docs/021-AT-ARCH-repo-blueprint-2026-06-10.md:524`** — the repo
   blueprint's predicate-URI table records `evals.intentsolutions.io/gate-result/v1`
   as **`sigstore_staging`** with production-Rekor *"gated on the kernel SPEC.md
   fold"* — i.e. the blueprint itself documents the staging-only posture. This is
   corroborating evidence, not a promotion record.

### 2.3 The one build artifact, classified

`build/evidence/bundle-0.json` carries `"signing_mode":"rekor_production"`,
`"rekor_log_indices":[]`, and `"verification_status":"unverified"`. It is:

- **gitignored** (`git check-ignore` confirms; `.gitignore:8` = `build/`),
- **untracked** (no entry in `git ls-files build/`),
- a **local, regenerable build output** of `scripts/emit-evidence.ts`.

`rekor_log_indices: []` + `verification_status: "unverified"` confirm no Rekor
inclusion proof has been recorded against this row. It is a local emit-plumbing
output, not a promoted production attestation.

## 3. Finding

**ZERO j-rig evidence rows were promoted from `sigstore_staging` to
production-Rekor before DR-018.** This matches the expected count exactly.

Consequently the CISO carve-out's re-emission + supersession branch **does not
trigger**. There is no non-conformant production-Rekor row to supersede. The
forensics pre-merge gate on the j-rig v2.0.0 PR is **satisfied**.

The repo's posture is internally consistent: at v1.1.0 j-rig is a staging-tier
emitter; the only `rekor_production` strings in the tree are the *claimed* signing
mode in forward-looking emit plumbing (gitignored output + the CI signing path),
never a record of a completed promotion. Production-Rekor eligibility begins at
v2.0.0 and only after the per-predicate DNSSEC + CAA + SPEC.md gate clears.

## 4. Release-note language for the v2.0.0 cut (binding)

DR-018 § 6.2 (CMO binding minority constraint) + § 6.3 (release-note structure,
item 7) require the staging-stays-staging decision to be **public** in the
v2.0.0 release notes. The v2.0.0 `CHANGELOG.md` / release notes MUST carry, with
the per-DR ordering:

> **Staging-tier attestations.** v2.0 introduces the normative predicate shape
> per Blueprint B § 7.4; staging-tier attestations emitted by prior versions are
> non-conformant by design and will age out of the staging log. New v2.0+
> attestations conform to the normative shape and are eligible for
> production-Rekor promotion only after the per-predicate gate
> (SPEC.md normative + DNSSEC + CAA verified for `evals.intentsolutions.io`)
> clears.

No silent transition. Forensics (this document) confirm there are no
production-Rekor rows from prior versions to re-emit or supersede.

## 5. Disposition

- **Forensics result**: ZERO promotions (expected: zero). ✅
- **CISO carve-out re-emission/supersession branch**: not triggered.
- **v2.0.0 PR pre-merge gate**: satisfied (this AAR is the evidence artifact).
- **Unblocks**: bead `iaj-E02` (kernel schema migration) may proceed; no
  production-Rekor cleanup is a precondition.

## 6. Cross-references

- DR-018 § 6.2 Q1(b) + § 6.3 release-note structure: `intent-eval-lab/000-docs/018-AT-DECR-isedc-council-session-5-jrig-reconciliation-2026-05-21.md`
- Kernel `signing_mode` enum + `EvidenceBundle`: `@intentsolutions/core` `schemas/v1/evidence-bundle.schema.json`
- Forward-looking emit plumbing: `scripts/emit-evidence.ts`
- Predicate-URI staging posture: `000-docs/021-AT-ARCH-repo-blueprint-2026-06-10.md` § (predicate-URI table)
