# Nightly provider admission

The default roster keeps all 14 skills, MiniMax-M3, five judge samples and the
pinned corpus. `JRIG_MINIMAX_PLAN_ADMISSION=1` enables quota admission for the
canonical MiniMax endpoint in the nightly workflow. Other providers and ordinary
CLI invocations keep their existing behavior.

The policy serializes provider requests and spaces their starts by at least one
second. Before the first request, and at most every 30 seconds thereafter, it
reads the existing key's plan quota. Logs contain only explicit remaining
percentages and reset timestamps. Credentials, prompts, provider response bodies
and account identifiers are never logged by admission.

A zero remaining percentage prevents a completion request. Admission can wait
once per provider instance (one per default-roster skill) for a reset within
70 seconds, then must obtain a fresh positive quota reading. A longer exhausted window, unavailable quota, or an
ambiguous legacy response fails closed. The parser deliberately does not infer
remaining allowance from `*_usage_count`: MiniMax's own CLI documents conflicting
interpretations of those older fields. It accepts explicit percentages for the
exact model, `MiniMax-M*`, or the current `general` pool.

An explicit HTTP 429 uses that same recovery allowance. It checks
quota again, waits up to 70 seconds (respecting a longer `Retry-After` by refusing
the retry), and checks quota before retrying the rejected request. A second 429
opens the circuit for queued calls. An explicit overload code 2064 on HTTP 503
or 529 may use that **same single allowance**, after a 30-second cooldown and
fresh positive quota check. The overload body must have no `choices` or `usage`
field; a generic 5xx, a timeout, or a completed response is never replayed.
`Retry-After` is respected up to the shared 70-second bound. An unsuccessful
retry keeps queued calls blocked. This can add at most one request per skill;
it does not grant separate retries for quota and overload failures. Caller
cancellation includes queueing and waits. No key replacement, provider fallback,
purchase or billing change occurs.

The 120-second default judge deadline and 20-minute per-skill bound remain.
The workflow allows 300 minutes: 14 serial skills × 20 minutes, plus 20 minutes
for setup and evidence emission/signing/verification. A deterministic test
checks the workflow budget against the actual roster length and runner limit.
This is a ceiling, not a claim that a healthy run should take five hours.

The default nightly MiniMax-M3 functional calls start with a 16,384-token output
budget instead of 8,192, through the existing `JRIG_MAX_OUTPUT_TOKENS` setting.
Explicit token, model, or gateway settings win; other providers and models keep
their existing defaults. The higher ceiling can increase per-call usage and runtime,
but quota admission and the per-skill deadline still apply. It does not change
judge sampling, model identity, thinking mode, corpus, criteria, or promotion
gates. A completed response that exhausted its budget is still an infrastructure
error and is never automatically replayed.
Incomplete evaluations remain `error`; behavioral failures remain `fail`, and the
existing signing and verification pipeline preserves both. A green Actions job
alone is not evidence that all evaluations completed.

## Incident evidence and limits of inference

Scheduled run [39196143557](https://github.com/jeremylongshore/j-rig-skill-binary-eval/actions/runs/39196143557)
started the first skill at 03:45:25 UTC on 2026-10-19. Five skills completed before
six consecutive skills encountered code 2062 between 03:59:35 and 04:00:38 UTC.
The remaining three completed. Published outcomes were six advisory, two fail and
six infrastructure errors. The runner previously had neither admission nor
backoff, so it immediately dispatched subsequent skills during the limit.

Recovery during the same run establishes that the condition was temporary. The
historical logs contain no quota snapshot, so they cannot distinguish a short
traffic throttle from the end of a longer usage window. Code 2062 alone does not
establish which window expired. Do not label that distinction proven until the
same CI credential's quota telemetry establishes it.

MiniMax documents five-hour and weekly usage windows, shared across tools, plus
shorter traffic throttles that typically recover in about a minute. Admission
uses returned reset timestamps rather than assuming a UTC reset schedule. The
70-second recovery cap is an operational bound, not a claim about a plan tier.

Sources:

- [MiniMax plan FAQ and quota endpoint](https://platform.minimax.io/docs/m-plan/faq)
- [MiniMax error codes](https://platform.minimax.io/docs/api-reference/errorcode)
- [MiniMax CLI quota interpretation](https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts)

Refs bead `bd_000-projects-hlwz`. Resolution additionally requires a real default
roster run with no provider-limit infrastructure errors and independent signed
evidence verification. Deterministic tests and quota-only reads do not establish
that live acceptance criterion.

## Completion follow-up (2026-10-19)

Replacement run [39208558770](https://github.com/jeremylongshore/j-rig-skill-binary-eval/actions/runs/39208558770)
was cancelled by the 90-minute job limit before `skill-creator` completed.
Thirteen results were retained: four behavioral failures, six advisory outcomes,
and three infrastructure errors. Signing and publication did not run. Two
errors reported server overload code 2064; one MiniMax-M3 functional call
returned empty content with `finish_reason=length`. The last quota reading was
80% of the interval allowance and 96% of the weekly allowance remaining; no
2062 was observed. This does not establish why the older limit occurred.

The overload classification above is grounded in the observed response message;
the public error-code table does not currently enumerate 2064. MiniMax's
[OpenAI-compatible API documentation](https://platform.minimax.io/docs/api-reference/text-openai-api)
confirms that thinking tokens count toward `max_tokens` and may exhaust it before
content is produced. Raising the initial ceiling is a bounded configuration
change, not a guarantee against future truncation or a change to the purchased
plan. No priority service tier, provider fallback, or model migration is enabled.

Refs beads `bd_000-projects-ldri` and `bd_000-projects-fhjl`. Offline recovery tests
and source fixes do not substitute for the complete signed default-roster run
required by `bd_000-projects-hlwz`.
