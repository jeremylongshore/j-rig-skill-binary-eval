# Evaluator Infrastructure Failure Boundary

**Status:** Accepted implementation contract (revised 2026-09-19)  
**Date:** 2026-08-02, revised 2026-09-19  
**Scope:** `j-rig eval`, provider adapters, SQLite run evidence, `gate-result/v1` rows  
**Authority:** Blueprint B § 7.4 (`gate_decision` semantics) in `intent-eval-lab`

## Decision

A provider outage is evidence about the **evaluator**, never a result about the
**skill**. When a provider call the evaluation depends on does not come back,
`j-rig eval`:

1. produces **no verdict** on the skill, and
2. still produces **evidence**: one kernel-valid `gate-result/v1` row with
   `gate_decision: "error"`.

Blueprint B § 7.4 already defines this: `error` means "the gate ran into
infrastructure failure"; it "is NOT a verdict on the input; it is a verdict on
the gate's own ability to evaluate"; `gate_reasons[0]` MUST capture the error
class and the row SHOULD carry a structured `metadata.error_detail`. This
contract applies that rule to every provider failure, not a subset.

## What counts as an infrastructure failure

Either of the following, in the skill pass or the opt-in naked-baseline pass:

- **Execution:** a test case whose provider call failed, timed out, or returned
  a provider error. It is never judged: grading an error string as if it were
  skill behavior spends judge tokens to manufacture a false signal.
- **Judge:** a judged criterion whose **every** sample errored (the judgment
  carries `judge_error`).

One failure is enough. A score computed over the criteria that happened to
survive is not a measurement of the skill, so a partial outage is `error`
exactly as a total one is.

What does **not** count:

- A **completed response with empty text**. That is retained as the
  tool-dependent boundary evidence a completion-only eval deliberately keeps.
- **Partial sample loss** within a multi-sample criterion. The judgment engine
  already counts an errored sample as an `unsure` vote, so it lowers agreement
  and can trip the stability gate. Only a criterion with zero surviving samples
  is an outage. Running `--samples` of 2 or more is therefore the supported way
  to absorb a transient failure; there is no hidden retry.
- A genuine `unsure` verdict from a judge that answered.

## Runtime contract

For a model whose evaluation hit an infrastructure failure:

1. The `gate-result/v1` row (with `--emit-bundle`) and the OTel
   `gate.decision` are `error`. This wins over every rollout mapping.
2. `gate_reasons[0]` names the error class, then the scope, then the redacted
   provider message:

   ```text
   provider_failure/judge [groq rate_limit, retryable]: judge provider failed on 1 of 3 judged criteria; the evaluation is incomplete: HTTP 429 slow down
   ```

   A total judge outage keeps the original wording, `judge provider failed on
   every judged criterion (N/N); nothing was evaluated`, so existing flap
   reports and alerts keep matching.

3. `metadata.error_detail` carries the typed, credential-free failure:

   ```json
   {
     "type": "provider_failure",
     "phase": "execution",
     "provider": "deepseek",
     "category": "rate_limit",
     "retryable": false,
     "affected": 2,
     "total": 2,
     "message": "Insufficient Balance"
   }
   ```

   `phase` is the earliest phase that failed; an execution failure masks a
   judge failure. `affected`/`total` count test cases for `execution` and judged
   criteria for `judge`.

4. The SQLite `runs` row transitions to `failed` and `runs.error_message`
   stores the same JSON.
5. Under `--json`, stdout remains the normal per-model results object. The
   affected model additionally carries `gate_decision: "error"` and
   `evaluation_error` (the same object). When `evaluation_error` is present,
   `scoreCard`, `decision`, and `report` are **diagnostic only** and MUST NOT be
   read as a verdict.
6. The process exits **2** after every artifact is flushed. Exit 0 means every
   model was evaluated; verdicts are reported in the bundle, not the exit
   status. Exit 1 is a crash.
7. Other models in the same invocation are unaffected and keep their own rows.

`eval-batch` and `suite` retain the failure in their manifests and continue
other independent cells under their existing failure policy.

## Credential boundary

Provider text is redacted by the single core redactor (`redactProviderError`,
`000-docs/021`) **at the point it is captured**: in the functional runner for
execution errors and in the judgment engine for judge errors. Nothing
downstream re-implements redaction. The typed `provider_failure` metadata
deliberately excludes the upstream message; only the redacted, length-capped
string reaches `gate_reasons` and `error_detail.message`.

## Error classification

The existing `rate_limit` category covers request throttling and exhausted
quota or credits. HTTP 402 and messages such as `Insufficient Balance` are
classified as **non-retryable** until the account is funded; a 429 stays
retryable. This keeps the provider taxonomy stable while preserving the
operational distinction in `retryable`. An untyped timeout is reported as a
retryable `network_timeout`; any other untyped failure is `unknown`.

## Decision record: why one rule, and why it signs

Two earlier designs covered parts of this and disagreed with each other.

- **Fail closed and emit nothing** (the original version of this document,
  2026-08-02). Any execution or judge failure on a real provider threw, exited
  non-zero with an `evaluation_failed` object, and wrote no Evidence Bundle.
  Right that an outage must never become a grade. Wrong to emit nothing: the
  platform's unification thesis is that every gate emits evidence, and a
  missing row is indistinguishable downstream from a gate that never ran. It
  also bypassed the kernel's own `error` verdict and added a second redactor.
- **Sign `error`, but only for a fully dead judge** (2026-09-06, after the
  conference audit's "make it lie" battery signed a dead judge as `advisory`).
  Right to use the kernel's `error` and to keep signing. Too narrow: a judge
  that died on some criteria still signed a normal verdict over the survivors,
  and execution failures were ignored entirely, so a failed provider call was
  judged as if it were the skill's answer.

The unified rule keeps the first design's trigger (any failure, either phase)
and the second design's response (a signed `error` row, exit 2, reason first).
It is not a new contract: it is Blueprint B § 7.4 applied consistently.

Rejected alternative: keep partial judge outages as `advisory`. `advisory` is
allowed by the rollout gate by default and is the same shape as genuine
uncertainty, which is precisely the ambiguity the conference audit exploited.

Rejected alternative: add provider-level retries. It hides flakiness from the
evidence and duplicates what multi-sample voting already does in the open,
where the lost samples stay visible in `sample_verdicts`.

## Operator guidance

- A night with a provider outage publishes `error` rows. `intent-rollout-gate`
  blocks `error` by default, which is the intent.
- To ride out transient judge failures, evaluate with `--samples` of 2 or more.
- Fund, authenticate, or otherwise repair the provider, then rerun the same
  pinned skill and spec. Never backfill a synthetic score for an `error` row.
- Stub evaluations are unchanged (`J_RIG_ALLOW_STUB=1`, `ground_truth: false`).
  The test-only switches `J_RIG_STUB_JUDGE_FAIL` and
  `J_RIG_STUB_EXECUTION_FAIL` are documented in `STUB-PROVIDERS.md`.
- Historical rows are not rewritten; this applies to new executions.

## Verification

- `eval-infrastructure-failure.test.ts`: the detector and reason format,
  including empty-response and deterministic-`unsure` negatives, phase
  precedence, fallbacks, and redaction.
- `eval.e2e.test.ts` against the built CLI: total judge outage, partial judge
  outage (row, `--json`, and the `failed` ledger row), execution outage with
  the failed test case never judged, and a healthy run that still signs `pass`.
- Original motivating evidence (2026-08-02): a pinned DeepSeek invocation
  returned `Insufficient Balance` for both functional cases and previously
  exited zero with `ground_truth: true` and `decision: warn`.
