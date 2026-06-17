# After-Action: Configurable OpenAI-compatible provider (DeepSeek / Kimi / OpenRouter)

**Date:** 2026-06-16 · **Epic:** iaj-E10 follow-on (real-provider dogfood) ·
**Status:** DONE — real ground-truth eval ran against the live DeepSeek API
through the new configurable provider.

## Why

The workflow runtime runs on a Claude subscription (fine), but the j-rig
behavioral dogfood (`scripts/dogfood.sh`, iaj-E10) makes **external** API calls
to `api.anthropic.com` with `ANTHROPIC_API_KEY`. That external-API credit was
exhausted. DeepSeek credits are live and the key is already SOPS-encrypted in the
lab `.env.sops` (`DEEPSEEK_API_KEY`). DeepSeek, Kimi/Moonshot, OpenRouter, and
Together are all OpenAI-Chat-Completions-compatible, so a single configurable
adapter unblocks the dogfood today (DeepSeek) and stays drop-in for Kimi later.

## What was built

1. **Configurable OpenAI-compatible provider**
   (`packages/cli/src/providers/openai-compatible.ts`)
   - `RealOpenAICompatProvider` implements the vendor-neutral `Provider`
     contract (`complete` / `completeStream` / `callTool` / `batch`) speaking the
     OpenAI **Chat Completions** wire format
     (`POST {base}/chat/completions`, `Authorization: Bearer <key>`,
     `choices[0].message.content`). It routes the HTTP call through the SAME
     injectable `Transport` seam the Anthropic / LiteLLM / Vercel adapters use —
     **no new SDK dependency**, CISO-gate-clean (G-1 no key logging, G-2 no
     subprocess). The key is held in a private field and never echoed.
   - `OpenAICompatTriggerProvider` / `OpenAICompatExecutionProvider` /
     `OpenAICompatJudgeProvider` mirror the Anthropic bridges 1:1 (same prompts,
     same JSON parsing). A DeepSeek run and an Anthropic run differ ONLY in the
     backend, never in eval logic. The judge stays a SEPARATE invocation from the
     skill under test (design principle #2).
   - `resolveOpenAICompatConfig(env, preferred?)` is the env-driven config
     resolver + defaults table. Precedence: explicit `--provider` preset →
     generic `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` triple → built-in presets
     in order (deepseek → kimi → openrouter). Returns `null` when no compatible
     key is present (caller falls through to Anthropic / stub).

   | Preset | Key env | Base URL | Default model |
   |---|---|---|---|
   | `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` | `deepseek-chat` |
   | `kimi` / `moonshot` | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` | `kimi-k2-0711-preview` |
   | `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` |

   Model ids are env-overridable (`LLM_MODEL` / `--models`) because vendor model
   ids churn.

2. **Provider selection** (`packages/cli/src/commands/eval.ts`)
   - `selectProviders(model, preferred?)` now prefers an OpenAI-compatible
     endpoint first (DeepSeek → Kimi → OpenRouter → generic `LLM_*`), then the
     Anthropic Messages API, then stub. A `--provider` flag forces the choice
     (`deepseek|kimi|moonshot|openrouter|anthropic|stub`). An explicit preset
     whose key is absent is a hard miss — it does NOT silently route to a
     different vendor.
   - The stub opt-in short-circuit (`assertStubAllowed`) now keys off
     `hasAnyRealKey(preferred)` so a real DeepSeek/Kimi run is never gated behind
     `J_RIG_ALLOW_STUB`.
   - `--json` output records `provider` + `model` + `ground_truth`.

3. **`scripts/dogfood.sh`** — added `--provider deepseek|kimi|moonshot|openrouter|anthropic`
   (default **deepseek**). `--sops` decrypts the matching key
   (`DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `OPENROUTER_API_KEY` /
   `ANTHROPIC_API_KEY`) from the lab `.env.sops` to a memory var (never disk),
   then runs the real eval through the matching endpoint and emits + round-trip
   verifies the `gate-result/v1` Evidence Bundle.

4. **Kernel spec widening** (`@j-rig/core` `schemas/eval-spec.ts`) — `ModelTarget`
   changed from a Claude-only enum (`haiku|sonnet|opus`) to a non-empty string,
   so an eval spec can carry a concrete OpenAI-compatible model id
   (`deepseek-chat`, `kimi-k2-*`, `deepseek/deepseek-chat`). The Claude aliases
   still pass through unchanged. This was a blocker for ANY non-Anthropic
   provider: the spec loader rejected `deepseek-chat`. Backward-compatible —
   existing specs validate identically.

## The real run (ground truth)

`bash scripts/dogfood.sh --provider deepseek --sops --smoke` decrypted
`DEEPSEEK_API_KEY` to memory and ran the real smoke eval against
`api.deepseek.com`:

- `provider=deepseek model=deepseek-chat ground_truth=true`
- 3 real model calls: 1 deterministic (`output-not-empty` → **pass**, so DeepSeek
  returned real non-empty text) + 2 judge calls on `deepseek-chat` (one `no`, one
  `yes`).
- Rollout decision: **block** (the `mentions-ship-decision` blocker criterion got
  a `no` verdict — a true behavioral signal, not a plumbing error). The eval did
  its job.
- Evidence Bundle emitted + **round-trip verified**: valid `gate-result/v1`
  in-toto Statement, subject digest == skill `input_hash`,
  `predicate.gate_decision == fail`.

OTel events confirm the judge ran on `deepseek-chat`
(`judge.model_id: deepseek-chat`), terminal state `archived_failed`, 5.85 s.

This spent a trivial amount of DeepSeek credit — exactly the point: it proves the
external-API path works on a non-Anthropic provider.

## Tests + gate

- New deterministic tests via the fake `Transport` (NO live key in CI):
  `packages/cli/src/providers/openai-compatible.test.ts` (27 tests — config
  resolution precedence, wire format, error categorization, tool-call
  normalization, all three eval bridges). Plus 2 kernel tests for the widened
  `ModelTarget`.
- Full repo gate green: `pnpm run check` → lint + typecheck + **780 tests pass**.

## How to switch providers

Set at most three env vars:

```bash
# DeepSeek (default)
DEEPSEEK_API_KEY=sk-... node packages/cli/dist/index.js eval ./skill --models deepseek-chat
# Kimi / Moonshot
MOONSHOT_API_KEY=sk-... node packages/cli/dist/index.js eval ./skill --provider kimi
# Any OpenAI-compatible gateway
LLM_API_KEY=sk-... LLM_BASE_URL=https://gw/v1 LLM_MODEL=m node packages/cli/dist/index.js eval ./skill
```

**Where to get Kimi (K2):** Moonshot console
[platform.moonshot.ai](https://platform.moonshot.ai) /
[platform.kimi.ai](https://platform.kimi.ai), via
[OpenRouter](https://openrouter.ai) (`moonshotai/kimi-k2`), or the open weights on
[Hugging Face](https://huggingface.co/moonshotai) behind a self-hosted
OpenAI-compatible server (vLLM / SGLang).

## Files changed

- `packages/cli/src/providers/openai-compatible.ts` (new)
- `packages/cli/src/providers/openai-compatible.test.ts` (new)
- `packages/cli/src/commands/eval.ts` (provider selection + `--provider` flag + JSON metadata)
- `packages/core/src/schemas/eval-spec.ts` (`ModelTarget` widening)
- `packages/core/src/schemas/eval-spec.test.ts` (2 tests)
- `scripts/dogfood.sh` (`--provider` flag + per-provider SOPS key decrypt)
- `README.md` ("Choosing a provider" section)
