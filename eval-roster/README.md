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
once per provider instance (one per default-roster skill) for a reset within 70 seconds, then must obtain a fresh
positive quota reading. A longer exhausted window, unavailable quota, or an
ambiguous legacy response fails closed. The parser deliberately does not infer
remaining allowance from `*_usage_count`: MiniMax's own CLI documents conflicting
interpretations of those older fields. It accepts explicit percentages for the
exact model, `MiniMax-M*`, or the current `general` pool.

An explicit HTTP 429 uses that same recovery allowance. It checks
quota again, waits up to 70 seconds (respecting a longer `Retry-After` by refusing
the retry), and checks quota before retrying the rejected request. A second 429
opens the circuit for queued calls. Timeouts and successful completions are never
replayed. Caller cancellation includes queueing and waits. No key replacement,
provider fallback, purchase or billing change occurs.

The existing 120-second default judge deadline, 20-minute per-skill bound and
90-minute workflow bound remain. Serialization can increase evaluation time;
the live verification must establish that the complete roster still fits.
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
