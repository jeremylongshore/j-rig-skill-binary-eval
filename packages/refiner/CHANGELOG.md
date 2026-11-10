# Changelog

## [Unreleased]

### Added

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
