# Changelog

## [Unreleased]

- Bound assessed proposals to 1–8 operations before scoring and pin both judges
  to reviewed provider/model evidence. Anthropic judge metadata now reports the
  resolved transport model ID. Refs bead `bd_000-projects-214c.16` / #398.

### Added

- Bootstrap reviewed harvested rollouts and human-nominated golden traces with
  source/review provenance, explicit expectations, and lineage-preserving versions.
  Opt-in `eval --rollout-file` retains actual functional outcomes in a private,
  non-overwriting file. Refs `bd_000-projects-214c.15` / #397.

- `assessProposal` and `refine assess` enforce reviewed capability, leakage,
  calibration, and freshness evidence before fresh paired scoring. Completed
  assessments retain their full inputs and policy; the existing schema and
  statistical decision gate decides acceptance without moving the best pointer.

- `scoreWithEvidence` returns a freshly scored record and complete per-item
  results. Adversarial eval items produce an independently measured
  `adversarial_pass_rate` dimension; missing or inconsistent item evidence fails
  before producing a score.

### Fixed

- Bind scoring to the supplied frozen document and eval-set content instead of
  labeling a default directory evaluation with unrelated hashes. Validate input
  identity, explicit item expectations, and complete real-provider scorecards.
- Add `refine score --eval-set-file` for reviewed frozen inputs. Bootstrap drafts
  without expectations now fail before evaluator calls or score persistence.
- Isolate scoring files/database in private temporary storage and remove them
  after evaluator success or failure. Historical records remain unchanged.

## [0.5.1] - 2026-10-19

### Fixed

- Derive skill IDs with POSIX basename handling instead of an unanchored
  trailing-slash regex; preserve existing IDs and fallback behavior.
- Include the package license in the published artifact.
