# 010-TQ-SOPS-audit-harness-baseline-2026-05-01

**Document type**: Standard Operating Procedure (SOPS) — testing baseline
**Category**: Testing & Quality (TQ)
**Program**: VPS-as-the-home (`OPS-5nm`), Priority 6 (`OPS-z9b`) — fan-out batch
**Pilot reference**: jeremylongshore/Hybrid-ai-stack-intent-solutions PR #4

## What got installed

`@intentsolutions/audit-harness v0.1.0` vendored via:

```bash
curl -sSL https://raw.githubusercontent.com/jeremylongshore/audit-harness/main/install.sh | bash
```

Drops `.audit-harness/` (scripts) and `scripts/audit-harness` (wrapper).

## Why two layers of "harness" in one repo

This repo IS the j-rig seven-layer binary evaluation harness for Claude Skills (`SKILL.md` artifacts). The `@intentsolutions/audit-harness` install adds a complementary, lower-level 7-layer **testing taxonomy** gate against this repo's own code (TypeScript/Node). The two systems are independent:

- **j-rig** evaluates Claude Skills authored in any repo
- **audit-harness** enforces test quality on j-rig's own implementation

No conflict. They live side-by-side.

## Deferred

- `/audit-tests` skill run → `TEST_AUDIT.md`
- `tests/TESTING.md` policy authorship
- Pre-commit + CI wiring for `escape-scan --staged`

## Cross-references

- Plan: `~/000-projects/intentsolutions-vps-runbook/plans/2026-05-01-vps-as-the-home/00-plan.md` § Priority 6
- Tracker: `~/000-projects/intentsolutions-vps-runbook/docs/repo-baseline-tracker.md`
- IS Testing SOP: `~/.claude/CLAUDE.md`
- Bead: `OPS-z9b`
