# Deep-dive: two j-rig eval-engine bugs that inflated every eval into a false NO-SHIP

**Code:** 028-DR-FIND · **Date:** 2026-06-28 · **Repo:** `j-rig-binary-eval`
**PR:** [#162](https://github.com/jeremylongshore/j-rig-skill-binary-eval/pull/162) ·
**Bead:** `bd_000-projects-xduf`
**Status:** Platform bugs fixed; residual is a documented harness limitation (see § 5).

## 0. TL;DR

Two **platform** bugs in the j-rig eval engine — not skill defects — corrupted
the scorecard of every eval that used per-test-case criteria scoping or
deterministic criteria:

1. **`criteria_ids` was never honored.** The engine judged *every* criterion
   against *every* observed outcome, so an off-topic functional criterion got
   judged against an unrelated control prompt → naturally `"no"` → a **false
   blocker**.
2. **A deterministic criterion with no `deterministic_check` faked a runtime
   `"no"`** at judgment time instead of being rejected at spec-load — a synthetic
   blocker manufactured out of an authoring mistake.

Both bugs bit two real evals: the `databricks-cost-leak-hunter` eval
(ended **2.7% / BLOCK**, "7 false blockers") and the `beads-dolt` dogfood
(NO-SHIP). The de-stub itself was fine (real DeepSeek, `ground_truth: true`,
exit 0); these two bugs sat on top of it and swamped the signal.

After the fix, the same `databricks-cost-leak-hunter` eval gives an **honest**
signal: trigger precision/recall **1.00 / 1.00**, `criteria_ids` honored (9
scoped judgments instead of ~42), control prompts judged against **zero**
criteria, no fake deterministic `"no"`. The residual BLOCK is real and
documented: a live-integration skill has no functional output to grade without a
recorded-data fixture (§ 5).

## 1. The end-to-end eval data-flow (where the bugs live)

`registerEvalCommand` (`packages/cli/src/commands/eval.ts`) drives, per model:

```text
Phase 2  checkPackage(absDir)                              → package integrity
Phase 3  runTriggerTests(spec.test_cases, roster, …)       → trigger precision/recall
         runFunctionalTests(spec.test_cases, skill, …)     → ObservedOutcome[] (1 per executed case)
         for (outcome of outcomes)
             judgeCriteria(spec.criteria, outcome, …)       ← BUG #1 lived here
         computeScoreCard(allJudgments, spec.criteria)      → blocker_failures
         decideRollout(scoreCard)                           → ship | warn | block
```

- `ObservedOutcome.test_case_id` (`packages/core/src/execution/types.ts:48`)
  carries the originating test case id — the join key that was never used.
- `TestCase.criteria_ids` (`packages/core/src/schemas/test-case.ts:41`) is
  documented *"Which criteria this test case evaluates (defaults to all)"* — and
  was read **nowhere** in the engine.
- `judgeCriteria` (`packages/core/src/judgment/engine.ts`) loops every passed
  criterion; for `method: deterministic` it calls `judgeDeterministic`, which
  returned a fake `"no"` when `deterministic_check` was absent.

## 2. Bug #1 — `criteria_ids` never honored (the core defect)

### Symptom

`eval.ts` passed **all** `spec.criteria` to `judgeCriteria()` for **every**
`outcome`:

```ts
// BEFORE
for (const outcome of outcomes) {
  const judgments = await judgeCriteria(spec.criteria, outcome, providers.judge, { model });
  …
}
```

So a Databricks-cost criterion (`produces-cfo-grokkable-report`,
`dollars-from-billing-not-estimates`, …) was judged against the
`"Write a Python function that reverses a linked list"` control prompt. The
judge correctly answered `"no"` (a linked-list reversal is not a CFO-grokkable
cost report). Each such `"no"` on a **blocker** criterion became a blocker
failure → `decideRollout` → BLOCK. With 6 functional outcomes × ~7 criteria, the
scorecard carried ~42 judgments, most of them off-topic false negatives.

### Fix

A pure, tested helper performs the documented scoping; `eval.ts` looks up each
outcome's test case and filters before judging:

```ts
// packages/core/src/judgment/criteria-selection.ts
export function selectCriteriaForTestCase(criteria, criteriaIds) {
  if (criteriaIds === undefined) return criteria;        // absent → ALL (documented default)
  const wanted = new Set(criteriaIds);
  return criteria.filter((c) => wanted.has(c.id));        // present (incl. []) → only named
}

// packages/cli/src/commands/eval.ts
const testCaseById = new Map(spec.test_cases.map((tc) => [tc.id, tc]));
for (const outcome of outcomes) {
  const testCase = testCaseById.get(outcome.test_case_id);
  const applicable = selectCriteriaForTestCase(spec.criteria, testCase?.criteria_ids);
  const judgments = await judgeCriteria(applicable, outcome, providers.judge, { model });
  …
}
```

**Contract** (backward-compatible with the schema's documented default):

- `criteria_ids` **absent** (`undefined`) → ALL criteria apply.
- `criteria_ids` **present, incl. empty `[]`** → only the named criteria apply.

The empty list is now meaningful: a `should_not_trigger` control case carries
`criteria_ids: []` so **no** functional criterion is judged against it — its
non-trigger is already tested by the orthogonal trigger layer
(`packages/core/src/trigger/runner.ts`).

## 3. Bug #2 — deterministic-no-check faked a runtime `"no"`

### Symptom

`packages/core/src/judgment/engine.ts:34-42`:

```ts
function judgeDeterministic(criterion, outcome) {
  if (!criterion.deterministic_check) {
    return { criterion_id: criterion.id, verdict: "no", confidence: 1,
             reasoning: "Deterministic criterion has no check defined", method: "deterministic" };
  }
  …
}
```

A `method: deterministic` criterion authored without a `deterministic_check`
(e.g. `cost-leak-hunter`'s original `triggers-on-cost-question`) produced a
phantom `"no"` on **every** outcome — a blocker failure manufactured from an
authoring slip, surfacing as a mid-run scorecard pollutant rather than a clear
authoring error.

### Fix

Catch it at **spec-load** via a Zod refine on `CriterionSchema`
(`packages/core/src/schemas/criterion.ts`):

```ts
.refine((c) => c.method !== "deterministic" || !!c.deterministic_check, {
  message: "deterministic criteria must define deterministic_check",
  path: ["deterministic_check"],
});
```

Now `j-rig validate` rejects it up front:

```text
$ j-rig validate bad-spec.yaml
✗ Invalid eval spec:
  criteria.0.deterministic_check: deterministic criteria must define deterministic_check
exit=1
```

The engine guard is **kept** as defense-in-depth for any criterion that reaches
judgment without passing through schema validation.

## 4. Before / after (databricks-cost-leak-hunter, DeepSeek `deepseek-v4-flash`)

The cost-leak-hunter eval-spec was also corrected (the CCPI-repo skill file):
`triggers-on-cost-question` deterministic-no-check → `judge` with an
on-topic-engagement prompt; removed from the two `should_not_trigger` controls
(`criteria_ids: []`); `models: [deepseek-chat]` → `[deepseek-v4-flash]`.

| Dimension | Before (platform-buggy) | After (platform-fixed) |
|---|---|---|
| Judgment pass-rate | **2.7% → BLOCK** | 1 PASS / 2 no / 6 unsure of **9** → BLOCK (honest) |
| Judgments evaluated | ~42 (all criteria × all outcomes) | **9** (`criteria_ids` honored) |
| Control prompts (weather, linked-list) | judged against cost criteria → false `"no"` | judged against **0** criteria |
| `triggers-on-cost-question` | deterministic-no-check → fake `"no"` ×6 ("7 false blockers") | real judge criterion (no fake `"no"`) |
| Trigger precision / recall | swamped by judgment noise | **1.00 / 1.00** (6 cases) — clean, real |
| Package integrity | 18/18 | 18/18 |
| `ground_truth` | true | true |
| Exit code | 0 (BLOCK is a completed eval, not an error) | 0 |

The single PASS after the fix is real: on `bill-too-high` the model produced a
structured `$500 Billed / $300 At-risk` split that legitimately passed
`splits-confirmed-vs-estimated`. The platform noise is gone; what remains is a
genuine harness limitation, not a false blocker.

## 5. Methodology note — why the residual BLOCK is honest, not a bug

`databricks-cost-leak-hunter` is a **live-integration** skill: it reads a real
workspace's `system.billing.usage` to produce confirmed-dollar reports. The
functional layer executes the skill body against a pure LLM with **no Databricks
target**, so its output is non-deterministic — sometimes a plausible fabricated
report (`bill-too-high`), often empty (`find-wasted-dbus`, `finops-report`). Two
consequences:

1. **Output-dependent functional criteria** (`produces-cfo-grokkable-report`,
   `dollars-from-billing-not-estimates`, `checks-grant-chain-upfront`) correctly
   land **unsure/no** against empty or fabricated output — an honest N/A, not a
   pass and not a platform false-negative.
2. **A trigger-shaped criterion** (`triggers-on-cost-question`) is *redundant*
   with the trigger layer (which scored 1.00 / 1.00) and, judged against empty
   functional output, returns a real `"no"`. Triggering is best tested by the
   trigger layer, not re-litigated as a functional blocker.

**Lessons for live-integration skills:**

- **Functional Tier-3B needs a recorded-data fixture.** Inject a captured
  `system.billing.usage` sample via the test case's `context_hints` so functional
  execution grades deterministic, real output instead of LLM-fabricated-or-empty.
  Without it, the functional layer's signal for a live-integration skill is noise.
- **Criteria must be `criteria_ids`-scoped or globally applicable.** A criterion
  that only makes sense for a subset of test cases MUST be scoped via
  `criteria_ids`; a criterion in a test case's `criteria_ids` MUST be judgeable
  from that case's output. Trigger/engagement assertions belong to the trigger
  layer (or to `should_trigger`/`should_not_trigger`), not to functional judging.
- **No-prompt-leakage caveat.** `no-prompt-leakage` is attached only to the
  adversarial-injection case, which `runFunctionalTests` filters out (tier
  `adversarial` with no `expected_output_contains`/`expected_artifacts`), so it is
  not functionally judged. Not flagged ≠ verified safe — give adversarial cases an
  `expected_output_contains` hook (or a dedicated safety layer) if leakage must be
  asserted.

## 6. By-design — explicitly NOT changed

- **Blocker-cascade** (`packages/core/src/governance/scoring.ts`): any blocker
  `"no"` → BLOCK, un-averageable. Correct per design principle #6 ("blockers
  block release"); bug #1 only *amplified* it by feeding it off-topic blockers.
- **Trigger / functional orthogonality** (`trigger/runner.ts`,
  `execution/runner.ts`): trigger tests run on cases with a
  `trigger_expectation`; functional tests skip pure-adversarial cases. Working as
  intended.
- **Judge fail-safe** (`engine.ts:63` `judgeWithLLM`): a judge error →
  `"unsure"`, never a silent pass. Working as intended.

## 7. The two evals that bit it

- **`databricks-cost-leak-hunter`** (CCPI `databricks-pack`): 2.7% / BLOCK with
  "7 false blockers" — bug #2 (deterministic-no-check on
  `triggers-on-cost-question`) plus bug #1 (cost criteria judged against weather
  / linked-list controls). The de-stubbed re-run above is the after-state.
- **`beads-dolt` dogfood**: NO-SHIP from the same engine defects; the dogfood's
  separate skill-quality finding ("lead with the fix" in `SKILL.md`) is a
  distinct repo-local fix tracked in its own repo, out of scope here.

## 8. Change inventory (PR #162)

| File | Change |
|---|---|
| `packages/core/src/judgment/criteria-selection.ts` | **new** — `selectCriteriaForTestCase` helper |
| `packages/cli/src/commands/eval.ts` | filter `spec.criteria` per outcome's `criteria_ids` |
| `packages/core/src/schemas/criterion.ts` | Zod `.refine()` — deterministic criteria must define a check |
| `packages/core/src/judgment/index.ts` | export the helper |
| `packages/core/src/judgment/criteria-selection.test.ts` | **new** — 6 tests |
| `packages/core/src/schemas/criterion.test.ts` | **new** — 3 tests |
| `packages/core/src/judgment/judgment.test.ts` | no-check test constructs the criterion directly (defense-in-depth) |
| `packages/core/src/optimizer/optimizer.test.ts`, `…/schemas/eval-spec.test.ts` | inline deterministic criteria given a real check |
| `packages/core/fixtures/valid/eval-spec.yaml` | trigger criterion → judge; format criterion → real `regex_match` check |

Full gate green: `pnpm run check` — lint + format + typecheck + **1212 tests**.
