# Skill Refiner Evidence Report — validate-skillmd — 2026-06-30

| Field                  | Value                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| Date                   | 2026-06-30T00:00:00Z                                               |
| Skill                  | validate-skillmd                                                   |
| Skill version (input)  | `a1b2c3d4`                                                         |
| Skill version (output) | `e5f6a7b8`                                                         |
| SkillVersion id        | 0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b                               |
| Parent SkillVersion id | 0190a0b1-c2d3-7e4f-8a5b-0c6d7e8f9a0b                               |
| Eval set               | `9f8e7d6c` v1.0.0                                                  |
| Verdict                | accept                                                            |
| Behavioral delta       | +0.1200 pp                                                        |
| Named-dimension deltas | readability +0.0100 (non-regressed); brevity +0.0000 (non-regressed) |
| Significance level (α) | 0.05                                                              |
| Test statistic         | one-sided-z                                                       |
| Refiner strategy       | skill-opt-style/v1                                                |
| Edit proposal          | `c0ffee12`                                                        |
| Signing mode           | staging                                                           |
| Rekor log index        | null                                                             |

## 1. Context

This skill was refined under trigger class `manual`. An operator ran the Skill
Refiner against `validate-skillmd` after the `authoring/v1` frontmatter overlay
gained a new required field, to check whether a bounded `SKILL.md` edit could
raise the behavioral pass rate on the frozen eval-set without regressing
readability or brevity.

## 2. Eval set composition

The verdict was derived against a frozen `synthetic` eval-set of `N = 24`
probes, stratified across trigger-match, functional, and adversarial slices. It
is pinned by `eval_set_ref` = { hash `sha256:9f8e7d6c…`, version `1.0.0`,
lineage_id `0190a0a0-b1b1-7c2c-8d3d-0e4e5f6a7b8c` }. This eval-set is the
epistemic basis of the claim; the rendered hash matches the signed kernel body
byte-for-byte.

## 3. Score trajectory

The before/after behavioral metric plus every named dimension's delta across the
pass. The behavioral dimension is significantly Pareto-dominant and no named
dimension regressed — the accept predicate holds.

| Dimension   | Baseline | Candidate | Delta   | Non-regressed |
| ----------- | -------- | --------- | ------- | ------------- |
| behavioral  | 0.7100   | 0.8300    | +0.1200 | —             |
| readability | 0.9000   | 0.9100    | +0.0100 | true          |
| brevity     | 0.8500   | 0.8500    | +0.0000 | true          |

## 4. Accepted edits (replayable)

Strategy `skill-opt-style/v1` proposed one `replace` op, targeting the observed
failure cluster (skills that under-specified the trigger phrasing). Rationale
(verbatim): *"Tighten the trigger sentence so the discovery layer matches the
canonical invocation; the failing rollouts all missed on paraphrased triggers."*

Pre-score → post-score: behavioral `0.7100` → `0.8300`. The acceptance-gate
evidence: behavioral delta `+0.1200` significant at α `0.05` (one-sided-z);
readability `+0.0100` and brevity `+0.0000` both non-regressed.

```diff
--- a/SKILL.md
+++ b/SKILL.md
@@ description @@
-Validate a SKILL.md file.
+Validate a SKILL.md file against the four-tier validation system. Trigger with
+"validate this skill", "grade my skill", "check SKILL.md".
```

The rendered edit hashes to `edit_proposal_hash` = `sha256:c0ffee12…`; a reader
can re-derive the bounded op and reproduce the post-edit artifact whose content
hashes to `result_snapshot_hash` = `sha256:e5f6a7b8…`.

## 5. Rejected edits (audit trail)

Two candidates were rejected before the accepted one cleared the gate:

| Candidate | Op class | Strategy            | Pre → post (behavioral) | Rejection reason          |
| --------- | -------- | ------------------- | ----------------------- | ------------------------- |
| cand-1    | add      | naive-in-context/v1 | 0.7100 → 0.7150         | no-behavioral-improvement |
| cand-2    | replace  | skill-opt-style/v1  | 0.7100 → 0.7900         | pareto-incomparable       |

`cand-2` improved the behavioral dimension but regressed brevity below the
non-regression bar, so it is Pareto-incomparable (DR-028 tie-break). Rejection
reasons are structured codes, not free prose, so no `SKILL.md` content leaks onto
a transparency log.

## 6. Hook-layer gate evidence (per pass)

| Pass | SkillVersion id | ScoreRecord hash | Signed row              | Rekor index | Hook layer          |
| ---- | --------------- | ---------------- | ----------------------- | ----------- | ------------------- |
| 1    | `0190a1b2…`     | `sha256:beef01…` | skill-refiner-pass/v1   | null        | line (L2)           |

The verdict was enforced by the line (L2) hook layer. Under `staging` no
production Rekor index exists yet, so the signed row's `rekor_log_index` is
`null`.

## 7. Signed Evidence Bundle (in-toto Statement v1)

The signed `skill-refiner-pass/v1` row: `predicateType` =
`https://evals.intentsolutions.io/skill-refiner-pass/v1`; the `subject` is the
post-edit artifact whose `digest.sha256` equals `result_snapshot_hash` without
the `sha256:` prefix (`e5f6a7b8…`). This row is `sigstore_staging` and carries no
production Rekor index.

Verify the DSSE-wrapped Statement with:

```bash
cosign verify-blob \
  --certificate-identity-regexp '^https://github.com/jeremylongshore/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --rekor-url https://rekor.sigstore.dev \
  --bundle skill-refiner-pass.bundle.json \
  result-snapshot.md
jq '.payload | @base64d | fromjson | .predicate' skill-refiner-pass.bundle.json
```

Each row is independently verifiable; there is NO top-level bundle signature
(Blueprint B § 7).

## 8. Architectural bindings

This report honors: DR-010 (unification thesis; every validator emits an
Evidence Bundle), Blueprint B § 7 (predicate-authority + no-top-level-bundle-
signature rules), the Canonical Glossary, DR-028 (the accept predicate +
SkillVersion semantics), and DR-082 / DR-085 (the predicate URI + one-way-door
corrections). The emission path honors the P0 beads on the signed-evidence
Tier-1 kernel track.

## 9. Limitations + risks

The frozen `N = 24` eval-set may not exercise every real invocation the skill
sees in the wild; the behavioral dimension can be Goodharted by a candidate that
over-fits the probe phrasing. Recommended re-validation cadence: re-bootstrap the
eval-set on any frontier-model bump or after 90 days, whichever comes first. This
accept verdict is a claim bounded by the frozen eval-set.

## 10. Status banding

Status: `ACTIVE`.
