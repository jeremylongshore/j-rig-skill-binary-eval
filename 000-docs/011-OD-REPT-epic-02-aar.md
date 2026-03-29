# Epic 02 — After Action Report

**Date:** 2026-03-29
**Epic:** 02 — Spec Layer and Contract System
**Status:** Complete

## What Was Delivered

### Schema Components
- `packages/core/src/schemas/criterion.ts` — Binary criterion schema (method, blocker, regression_critical, baseline_sensitive, pack_sensitive)
- `packages/core/src/schemas/test-case.ts` — Test case schema (tier, prompt, trigger_expectation, artifacts, criteria_ids)
- `packages/core/src/schemas/eval-spec.ts` — Eval spec schema (criteria, test_cases, models, siblings)
- `packages/core/src/schemas/eval-contract.ts` — Eval contract schema (purpose, trigger_boundary, success_criteria, blockers, safety, baseline, evidence_rules)
- `packages/core/src/schemas/skill-frontmatter.ts` — SKILL.md frontmatter schema (standard + enterprise tiers)

### Parsing Utilities
- `packages/core/src/parsers/yaml-parser.ts` — YAML parsing with Zod validation, structured errors, diagnostics formatting
- `packages/core/src/parsers/skill-parser.ts` — SKILL.md frontmatter/body parsing via gray-matter (standard + enterprise tiers)

### Fixtures
- `packages/core/fixtures/valid/` — eval-spec.yaml, eval-contract.yaml, skill.md
- `packages/core/fixtures/invalid/` — 7 invalid fixtures covering missing fields, bad names, bad methods, malformed YAML, missing frontmatter, bad descriptions

### Tests
- 34 tests passing (30 new + 4 existing)
- Schema validation tests for eval spec and contract (positive and negative)
- YAML parser tests (valid, invalid, empty, malformed, diagnostics formatting)
- SKILL.md parser tests (standard, enterprise, missing frontmatter, bad name, bad description)

### Documentation
- `000-docs/010-AT-SPEC-eval-spec-and-contract-guide.md` — Author-facing guide covering spec vs contract distinction, all fields, examples, common validation failures

## Quality Gate Evidence

```
pnpm run check → PASS
  lint:      0 errors
  typecheck: 0 errors (tests/ + core + cli + db)
  test:      34/34 passed (8 test files)
  build:     3/3 packages built successfully
```

## Key Schema Decisions

1. **Spec and contract are distinct** — spec is machine-executable (criteria + test cases), contract is human-negotiated (purpose + boundaries + blockers)
2. **All criteria are binary** — `method: "deterministic" | "judge"`, no gradients
3. **Blocker criteria cannot be averaged out** — `blocker: true` means failure blocks release
4. **Versioned schemas** — `spec_version: "1.0"` and `contract_version: "1.0"` for forward compatibility
5. **Zod for validation** — strict, explicit, rich diagnostics, no silent coercion
6. **gray-matter for SKILL.md** — AST-based frontmatter extraction, not regex
7. **Two-tier SKILL.md validation** — standard (name + description) vs enterprise (+ author, version, license, allowed-tools)

## Dependencies Added

- `zod` — schema validation
- `yaml` — YAML parsing
- `gray-matter` — SKILL.md frontmatter extraction
- `@types/node` (devDependency) — Node.js type definitions for test files

## What Epic 03 Inherits

- All schemas in `@j-rig/core` are canonical — Epic 03 imports them directly
- `parseAndValidateYaml()` is the standard way to validate YAML against schemas
- `parseSkillMd()` and `parseSkillMdEnterprise()` are the standard SKILL.md parsers
- Fixtures in `packages/core/fixtures/` are the reference test data
- Schema versioning (spec_version/contract_version) must be maintained
