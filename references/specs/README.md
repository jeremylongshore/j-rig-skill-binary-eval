# Skill Spec Snapshots — Source of Truth for JRig Evals

This directory holds versioned snapshots of the authoritative skill specs that JRig evaluates against:

| File                       | Source                                                                   | Why JRig reads it                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic-skills-spec.md` | [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) | The Anthropic spec floor — required fields, optional-field allow-list, substitution variables, DCI rules. JRig package-checker enforces these as deterministic checks. |
| `agentskills-spec.md`      | [agentskills.io/specification](https://agentskills.io/specification)     | The AgentSkills.io open standard — `compatibility`, `metadata`, `license`. JRig validates the free-text constraints (max 500 char compatibility, etc.).                |

## Why snapshots, not live-fetch

Live-fetching from CI on every eval is a rate-limit and flakiness risk. Capturing as a versioned snapshot here lets the PR review on each refresh be the human gate that catches breaking spec changes BEFORE they reach thousands of evaluation runs.

## How JRig consumes them

`packages/core/src/governance/spec-sources.ts` exposes a `loadSpecAuthority()` function that returns a frozen `SpecAuthority` with parsed rules and snapshot IDs. JRig checks call into the authority instead of hardcoding rules:

```typescript
import { loadSpecAuthority, classifyField } from "@j-rig/core";

const authority = loadSpecAuthority();
console.log(authority.anthropicSnapshotId);  // "2026-05-07-initial"
classifyField("name");                       // "required"
classifyField("when_to_use");                // "optional"
classifyField("tags");                       // "unknown" (IS-extension, not in Anthropic spec)
```

Eval reports record `anthropicSnapshotId` so a re-run weeks later against a refreshed snapshot can detect spec drift in either direction.

## Refresh procedure

1. Quarterly cron (or manual trigger) fetches the live spec URLs.
2. Diff against current snapshot — identify added / removed / changed fields.
3. Update the snapshot file content + bump `**Snapshot ID**` to `YYYY-MM-DD-NN`.
4. Mirror the changes into `packages/core/src/governance/spec-sources.ts` constants in the same PR (the test suite catches drift).
5. Open PR with the diff.
6. PR review = human gate. Required-field-set changes need explicit approval (per `SCHEMA_CHANGELOG.md` § NON-NEGOTIABLES in the consumer-side `claude-code-plugins` repo).
7. Merge → next eval run reads the new snapshot.

## Cross-repo coordination

These same snapshots live in `claude-code-plugins/000-docs/`:

- `000-docs/anthropic-skills-spec-snapshot.md`
- `000-docs/agentskills-spec-snapshot.md`

They are copied here verbatim so JRig is independently runnable without depending on the consumer-side repo. Refresh PRs should land in BOTH repos in lock-step. Future enhancement: a sync script that diffs the two locations and fails CI on divergence.

## Status (2026-05-07)

**Initial seed snapshots.** Captured against the Anthropic + AgentSkills.io docs as understood at this date. First quarterly refresh PR will diff against live URLs and update IDs to `2026-08-NN-NN`.
