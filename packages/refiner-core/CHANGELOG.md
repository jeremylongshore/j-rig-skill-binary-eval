# Changelog

## [Unreleased]

### Fixed

- Count cross-set prompt leakage with one-to-one matches so duplicate prompts
  cannot inflate the smaller-collection overlap ratio above one. Self-comparison
  still reports repeated occurrences after the first.
- Reject non-finite calibration confidence values before computing Brier score
  and expected calibration error.

## [0.5.1] - 2026-10-19

### Changed

- Publish in lockstep with Refiner 0.5.1 as required by the package release
  workflow. The pure core has no runtime source changes since 0.5.0.
- Include the package license in the published artifact.
