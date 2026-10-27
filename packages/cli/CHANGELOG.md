# Changelog

## [0.5.1] - 2026-10-19

### Fixed

- Bundle the existing frontmatter parser without installing its unused
  argparse/sprintf-js command-line dependency chain. The private build
  workspace still reports the upstream advisory; it is not patched upstream.
- Bound MiniMax plan admission and one shared recovery for explicit rate-limit
  or no-output overload errors; preserve evaluator infrastructure failures as
  incomplete evidence. Completed requests and ambiguous timeouts are never
  automatically replayed.
- Bound stopped Claude Code process pipe draining and retain workspace receipts.
- Read an evidence file through the descriptor used to inspect it and return
  structured file-system errors.
- Consume Refiner 0.5.1 and include bundled dependency and package licenses.

### Changed

- Build with TypeScript 6 using the documented version-pinned tsup patch.
