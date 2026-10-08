# 047 AT-SPEC: Eval cost and latency budgets, MiniMax and Claude rates

**Status:** Implemented, 2026-10-08.
**Bead:** dn6j.5 (Add cost and latency budgets to J-Rig evals and include MiniMax and Claude rates).
**Origin:** whiteglove-pdf `000-docs/010-TQ-QAPL-iep-test-plan.md` § 6, gap 5.

## Problem

`j-rig eval` measured cost after the fact but could not cap it: no budget field,
no spend limit, no wall-clock limit. `MODEL_RATES_USD_PER_MTOK` had no MiniMax or
Claude rows, so the nightly roster's spend (MiniMax judge) and claude-code
execution runs reported `estimated_usd: null`.

## Budget

Four optional limits, set in the spec, on the command line, or both:

| Limit | Spec (`budget:`) | Flag | Counts |
| --- | --- | --- | --- |
| USD | `max_usd` | `--max-usd` | API-equivalent USD from the rate table |
| Tokens | `max_tokens` | `--max-tokens` | input + output tokens |
| Wall time | `max_wall_ms` | `--max-wall-ms` | ms since evaluation started (after load and package integrity) |
| Calls | `max_calls` | `--max-calls` | metered provider calls (claude-code: one per case) |

- **Scope.** One budget spans the whole invocation: every model in `--models`,
  every phase (trigger, execution, judge, naked baseline).
- **Merging.** When the spec and a flag both set a limit, the smaller wins and
  the result records which one (`source: spec | run`). A flag can tighten a
  spec's budget, never loosen it.
- **Spec field.** `budget` is optional, strict (unknown limits are rejected),
  has no defaults, and must set at least one limit.

### Enforcement

A pre-call guard (`packages/cli/src/providers/budget.ts`) wraps every metered
provider outside the cost meter, plus the claude-code execution provider. Before
each call it asks whether any limit is reached; if so it refuses the call and
latches a `BudgetStop` (limit, max, observed value, source, phase, model,
elapsed, reason). A refused call is never recorded as spend.

Usage is only known after a call returns, so a run can overshoot a limit by the
calls already in flight when it was reached: one, or one criterion's concurrent
judge samples.

`max_usd` fails **closed**: if any recorded model has no rate on file, the next
call is refused with `observed: null` and a reason naming the model. A dollar
cap that cannot price the spend cannot honor itself.

### Clean stop

The eval command checks the latch after the trigger phase, before each judged
outcome, after the skill judge pass and after the naked-baseline pass. On a stop:

- the model gets **no verdict and no Evidence Bundle row**. It is not an `error`
  row: `error` means a provider failed (`037`), and the roster consumers accept
  only `provider_failure/` reasons;
- the run is stored `failed` with `{"type":"budget_exhausted", ...stop}` as its
  reason, and the JSON result carries `budget_stop`;
- later models are not started and appear as `{ "skipped": "budget_exhausted" }`;
- every result row carries `run_budget` (limits, sources, spent, stop);
- the process exits **3** after every artifact is flushed. Exit 3 wins over 2
  because the refused calls are not provider failures.

A stop inside the naked-baseline pass happens after the skill pass's criterion
results were persisted; they stay stored, but the run is `failed` and unverdicted.

## Rates

`MODEL_RATES_USD_PER_MTOK` rows gain an optional `cached_input` rate. Cache reads
are priced as a subset of input tokens (how the OpenAI-compatible and claude-code
adapters report them). Cache writes are not separately metered and price at the
input rate. Every row names its source and read date.

| Model | Input | Output | Cache read | Source (read 2026-10-08) |
| --- | --- | --- | --- | --- |
| `MiniMax-M3` | 0.30 | 1.20 | 0.06 | platform.minimax.io pay-as-you-go, Standard, ≤ 512k input (> 512k is 2x) |
| `MiniMax-M2.7` | 0.30 | 1.20 | 0.06 | same |
| `MiniMax-M2.7-highspeed` | 0.60 | 2.40 | 0.06 | same |
| `claude-fable-5-1` | 10.00 | 50.00 | 0.25 | Anthropic first-party list (claude-api reference, table cached 2026-09-25) |
| `claude-opus-5-5` | 4.00 | 20.00 | 0.20 | same |
| `claude-sonnet-5-5` | 2.00 | 10.00 | 0.20 | same |
| `claude-haiku-4-5-20251001` (+ `claude-haiku-4-5`) | 1.00 | 5.00 | 0.10 | same (cache read 0.1x input) |

MiniMax-M3 and M2.7-highspeed are the models the estate runs (the
`minimax-agent-shell` harness and braves-booth's M3 → M2.7-highspeed chain). The
estate's MiniMax keys are a Coding Plan subscription, so these are list-price
equivalents rather than the invoice.

Lookup (`lookupModelRate`) is exact, then case-insensitive; unknown models stay
`null`. A model with no verified rate is never guessed. The recorded claude-code
fixtures report `claude-haiku-5-5`, which has no verified list price, so that
model stays unpriced.

### Subscription-local claude-code usage

The claude-code provider reports usage as `claude-code/<model>`. Those rows are
priced at the base model's API rate and marked `billed: false` with the note
"API-equivalent at list rate; Claude Code subscription run, not billed". The
cost report adds `billed_usd` (the billed part of `estimated_usd`) and per-model
`billed`, `rate_key`, `cached_input_tokens`. `max_usd` counts the API-equivalent
figure, so a subscription run is capped at list price too.

## Not in scope

- Budgets for the generic substrate commands (`j-rig run`, `batch`, `suite`);
  their harnesses carry their own `timeout_ms`.
- The nightly roster treats exit 3 like any other non-2 failure (generic error
  log). No roster spec declares a budget today.
- The Anthropic adapter reports `input_tokens` excluding cache reads while the
  others include them; cache reads on the direct Anthropic path are rare in
  evals and the price is clamped, but the convention is not unified here.

## Tests

- `packages/cli/src/providers/budget.test.ts`: merging, each limit's stop, latch,
  unpriced `max_usd`, cross-model spend, the execution-provider guard.
- `packages/cli/src/providers/cost-tracking.test.ts`: the new rates, lookups,
  cache pricing, not-billed labelling, `billed_usd`.
- `packages/cli/src/commands/eval-budget.e2e.test.ts`: the built CLI against a
  local fixture endpoint: `--max-calls` stop (exit 3, no bundle, run `failed`,
  later model skipped), spec budget tightened by flag, unpriced `--max-usd`,
  a run within budget, a malformed flag.
- `packages/core/src/schemas/skill-eval-spec.test.ts`: the `budget` field.
