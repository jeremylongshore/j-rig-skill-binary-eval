# Stub Providers — Discipline + Risk Notice

> **TL;DR.** j-rig currently ships with *stub* implementations of the trigger, execution, and judge providers. **Stub output is not ground truth.** The CLI refuses to run unless you explicitly opt in via `J_RIG_ALLOW_STUB=1`. When the opt-in is set, a banner prints to stderr on every invocation. Do not consume any metric, decision, or rollout verdict from a stub run as evidence of skill quality.

## What "stub provider" means

The j-rig CLI is built around three external-API-shaped abstractions:

| Provider                            | Real shape                                                            | Stub behavior                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Trigger** (`TriggerProvider`)     | Calls a model to pick which skill should fire for a given user prompt | Always picks the first available skill; reasoning string is `[stub]`-prefixed                         |
| **Execution** (`ExecutionProvider`) | Calls a model with the selected skill body + user prompt              | Returns a synthetic response (`[stub] Would call …`) with zero latency, zero tool calls, no artifacts |
| **Judgment** (`JudgeProvider`)      | Calls a judge model to evaluate whether a criterion was satisfied     | Always returns `verdict: "yes"` with `confidence: 0.7`, reasoning `[stub] Would call …`               |

These stubs let the trigger / functional / judgment pipelines run end-to-end without any API key. They exist for **pipeline-plumbing development** — verifying that the wiring between roster building, test execution, score computation, decision logic, and reporting holds together. They do not produce evidence about the skill under test.

## Why this is dangerous if treated as ground truth

A stub run produces:

- Trigger metrics that look like 100% precision + 100% recall (the stub always picks the first skill, which the test cases are typically structured around).
- Functional outcomes that always succeed (synthetic response has no failure modes).
- Judge verdicts that always pass at confidence 0.7.
- A `ScoreCard` showing the skill "ships".
- A `decideRollout()` decision verdict.
- A `buildLaunchReport()` output that reads like a release-ready document.

**Every one of those outputs is a fabricated placeholder.** If a CI pipeline ingests them as evidence — for instance, a `tests/TESTING.md` gate that auto-promotes a skill on a 1.00 score — the gate is meaningless. Worse: the gate is *invisibly* meaningless. There is no error condition, no failed exit code, no missing file.

This failure mode is **silent ship**: a synthetic verdict that looks identical to a real one. The mitigation discipline below exists to make silent ship impossible.

## Discipline

### 1. Opt-in is mandatory

Every invocation of `j-rig eval` (and any future command that uses the stub providers) checks for `J_RIG_ALLOW_STUB=1` in the environment **before** instantiating any stub. Without it, the CLI throws:

```text
REFUSED: j-rig cannot run without a real provider implementation.

The Anthropic SDK adapter is not yet wired (iaj-stub-provider, PB-7). To opt
into stub mode for pipeline-plumbing development, set:

    J_RIG_ALLOW_STUB=1

BEFORE running the CLI. Stub-mode results are NOT ground truth — see
STUB-PROVIDERS.md for the full discipline.
```

This refusal is enforced in `packages/cli/src/providers/anthropic.ts` (`assertStubAllowed`) and called from `packages/cli/src/commands/eval.ts` before any stub instantiates.

### 2. Loud banner on every stub invocation

When stub mode is active, the first stub-class constructor in a process emits a multi-line warning banner to **stderr** (never stdout — preserves `--json` stream cleanliness). The banner declares:

- This run is using STUB providers
- Output is NOT ground truth
- Each stub's synthetic behavior is listed
- How to opt back to real mode

The banner is emitted exactly once per process via a module-scoped flag (subsequent stub constructions in the same process do not re-print).

### 3. CI gates must refuse stub-mode artifacts

When j-rig grows an `emit-evidence` path that produces Evidence Bundle rows for downstream consumption (e.g., by `intent-rollout-gate`), the emitted rows MUST carry a `provider.mode: "stub"` marker. Consumers MUST refuse rows where that marker is `"stub"` — a rollout-gate that ships a skill on stub evidence is the failure mode the discipline exists to prevent.

This marker landing is gated on the kernel-canonical schema migration (`iaj-E02b` per DR 018 § 9.2; kernel `iec-E12` ships `EvidenceBundlePayload` first). Until then, j-rig does not emit machine-consumable bundles from the `eval` command at all — only console output.

### 4. Backward-compat carve-out

The opt-in does NOT apply to:

- `j-rig check` (deterministic skill-package validation, no provider calls)
- `j-rig drift` (deterministic drift detection against a baseline)
- `j-rig validate` (schema + structural validation)
- `j-rig emit-evidence` (currently consumes input from stdin or a `--input` file; doesn't call providers itself)

Those commands run without `J_RIG_ALLOW_STUB=1`. The opt-in is scoped to commands that exercise the trigger / functional / judgment pipeline (`j-rig eval` and any future `j-rig optimize` that calls providers).

## How to acknowledge stub mode

For local development:

```bash
J_RIG_ALLOW_STUB=1 pnpm --filter @j-rig/cli exec j-rig eval ./path/to/skill
```

For CI configurations that explicitly want to test the pipeline plumbing without provider credentials, set the env var at the workflow level. The opt-in is visible in the YAML, which is the audit trail.

## When the real Anthropic adapter lands

Tracked as `iaj-stub-provider` (PB-7). On that change:

- Real `AnthropicTriggerProvider` / `AnthropicExecutionProvider` / `AnthropicJudgeProvider` classes implement the same interfaces as the stubs.
- `eval.ts` selects between real and stub based on:
  - `ANTHROPIC_API_KEY` set → real provider
  - `ANTHROPIC_API_KEY` unset AND `J_RIG_ALLOW_STUB=1` → stub provider with banner
  - Neither set → refuse with the existing error message
- Provider-mode marking lands on emitted Evidence Bundle rows (per the kernel-canonical schema migration timeline).
- This document is updated to describe the real-provider configuration path and the discipline shifts from "stubs require opt-in" to "stubs require opt-in AND real provider requires a key."

## References

- Bead: `iaj-stub-provider` (`bd_000-projects-lcgu`, P0) — wire the real provider
- IEP Convergence Debt Plan Priority 2 — `iep-P2-j-rig-hardening` (`bd_000-projects-sqq8`)
- DR 018 (ISEDC Session 5, 2026-05-21) — kernel-canonical EvidenceBundle migration discipline
- Implementation: `packages/cli/src/providers/anthropic.ts` (`emitStubBanner`, `assertStubAllowed`)
- Enforcement test: `packages/cli/src/providers/anthropic.test.ts`
