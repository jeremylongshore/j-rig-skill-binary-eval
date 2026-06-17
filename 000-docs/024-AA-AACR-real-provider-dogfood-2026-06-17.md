# After-Action: Real-provider behavioral dogfood (iaj-E10)

**Date:** 2026-06-17 · **Epic:** iaj-E10 (1p1) "Internal dogfood pass" ·
**Status:** DONE — real ground-truth dogfood ran against the live Anthropic API.

## What changed from the prior pass

The prior dogfood used **stub providers** (`StubTrigger/Execution/Judge` behind
`J_RIG_ALLOW_STUB=1`). Stub output is explicitly NOT ground truth — the stub
judge always returns `yes`, so every decision was synthetic. This pass replaces
that with a **real Anthropic provider** so the trigger, functional-execution, and
judgment layers all hit the live model and the rollout decision is real.

## What was built

1. **Real Anthropic provider** (`packages/cli/src/providers/anthropic-real.ts`)
   - `RealAnthropicProvider` implements the vendor-neutral `Provider` contract
     (`complete` / `completeStream` / `callTool` / `batch`) and speaks the genuine
     Anthropic Messages API wire format (`POST /v1/messages`, `x-api-key` +
     `anthropic-version` headers, `content:[{type:text}]` response). It routes the
     HTTP call through the SAME injectable `Transport` seam the shipped
     measurement adapters (`litellm.ts`, `vercel-ai.ts`) use — so it adds **no new
     SDK dependency** and stays CISO-gate-clean (G-1 no key logging, G-2 no
     subprocess). The shipped prototype adapters speak a normalized *gateway*
     shape (LiteLLM's OpenAI-compatible proxy / an AI-SDK gateway), not the raw
     Messages API, so a dedicated real adapter is what lets the dogfood hit
     `api.anthropic.com` directly.
   - `AnthropicTriggerProvider` / `AnthropicExecutionProvider` /
     `AnthropicJudgeProvider` bridge the real `Provider` into the three
     eval-pipeline interfaces the 7-layer `eval` command consumes. The judge is a
     SEPARATE invocation from the skill under test (design principle #2: the
     evaluator never judges itself).

2. **Provider auto-selection** (`packages/cli/src/commands/eval.ts`)
   - `selectProviders(model)` picks the real Anthropic path when
     `ANTHROPIC_API_KEY` is set (output = ground truth), else falls back to stubs
     — and stub fallback is still gated by the `J_RIG_ALLOW_STUB=1` opt-in. A real
     dogfood is never blocked behind the stub opt-in. The `--json` output records
     `provider` + `ground_truth` so downstream evidence can tell real from stub.

3. **j-rig's own skill** (`skill/SKILL.md` + `skill/eval.yaml`)
   - A real `j-rig-eval` Claude skill that wraps the harness itself (genuine
     self-dogfood — j-rig ships no SKILL.md of its own, being the eval harness).
     Passes 12/12 package-integrity checks. The eval contract carries 4 criteria
     (1 deterministic, 3 judge) across 4 test cases including an adversarial
     prompt-injection case.

4. **One-command dogfood harness** (`scripts/dogfood.sh`)
   - `bash scripts/dogfood.sh --sops` decrypts `ANTHROPIC_API_KEY` from the lab
     `.env.sops` to a memory var (never disk), runs the real eval, derives a
     gate-result envelope from the run's rollout decision, emits a
     signed-capable Evidence Bundle (`gate-result/v1` in-toto Statement) via
     `j-rig emit-evidence`, and **verifies the bundle round-trips** (asserts
     `_type`, `predicateType`, subject digest == skill input_hash,
     `predicate.gate_decision`). `--smoke` runs a single core case (1-2 model
     calls); `--sign` adds keyless cosign signing.

## The real run (ground truth)

Two runs against `claude-sonnet` via the live API:

| Run | Cases | Decision | gate-result/v1 | Pass rate | Round-trip |
| --- | --- | --- | --- | --- | --- |
| `--smoke` | 1 core | ship | pass | — | OK |
| full | 4 (incl. adversarial) | **block** | **fail** | 11/12 (91.7%) | OK |

The full run is the headline result: **a real behavioral finding a stub run could
never produce.** 11 of 12 criterion evaluations passed; **1 blocker criterion
failed** against the live model, so j-rig correctly returned `block` → the
Evidence Bundle carried `gate_decision: fail` and still round-tripped as a valid
`gate-result/v1` Statement. Both runs recorded `provider: anthropic`,
`ground_truth: true`, and **zero** stub-banner emissions (proof of the real path).

Committed evidence: `evidence/dogfood/` (smoke) + `evidence/dogfood-full/`
(`run.json` scorecard + `evidence-bundle.json` in-toto Statement). The bundles
carry only hashes, decisions, timestamps, and reason strings — no raw
prompts/responses, no PII, no secrets.

## How to reproduce

```bash
pnpm run build
bash scripts/dogfood.sh --sops --smoke     # cheap: 1 case, 1-2 model calls
bash scripts/dogfood.sh --sops             # full: 4 cases incl. adversarial
bash scripts/dogfood.sh --sops --sign      # + keyless cosign signing (needs OIDC)
```

Or with an explicit key: `ANTHROPIC_API_KEY=sk-ant-... bash scripts/dogfood.sh`.

## Remaining gap (precise)

The dogfood ran for real, end-to-end, with the Evidence Bundle verified. The one
deliberately-deferred sub-step is **production-Rekor-anchored signing**: the
harness supports `--sign` (keyless cosign), but a *production* attestation push
to the public Rekor transparency log is gated by the iah-E06 DNSSEC/CAA
pre-flight on `evals.intentsolutions.io` and is a one-way door — out of scope for
a dogfood. The unsigned Statement round-trips and verifies, which is the
correct dogfood boundary; production signing is the rollout-gate's job
(`intent-rollout-gate` v0.2.0, already live on prod Rekor per
`project_iep_production_signing_readiness`).

The full-run blocker failure is a real signal about the `j-rig-eval` skill
content (the model occasionally answered a borderline criterion as "no"); it is
recorded here as ground truth, not "fixed" — the point of the dogfood is that
j-rig surfaced it.
