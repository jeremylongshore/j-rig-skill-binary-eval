# @intentsolutions/refiner

Skill Refiner orchestrator + I/O adapters + CLI — **wave 2** of the Skill Refiner
buildout (Phase A). The pure foundation it builds on is
[`@intentsolutions/refiner-core`](../refiner-core) (wave 1).

Published as `@intentsolutions/refiner@0.1.0` to npm under the `@intentsolutions` scope
per CEO directive 2026-06-21. CLI identity remains `j-rig refine` (unchanged).

This is the I/O half of the value-oriented Refiner discipline whose pure half
lives in `@intentsolutions/refiner-core`. It supplies the four pieces of plan 027 § 4
Phase A build-order steps 4–7:

| Step | Piece | Module |
|------|-------|--------|
| 4 | Content-addressed store + append-only event log + single mutable best-pointer | `store.ts` (`RefinerStore`) |
| 5 | `score()` — delegate to the existing `j-rig eval` via an injectable shell-out | `score.ts` |
| 6 | `propose()` — tiered (`haiku`\|`sonnet`, **never opus**) Anthropic-backed `RefinerModel` wired to a refiner-core `RefinerStrategy` | `propose.ts` |
| 7 | The 5 `j-rig refine <cmd>` CLI commands | `cli.ts` |

## Reuse, not reinvention

Per the plan's "Reuses existing infrastructure" mandate:

- **`score()` delegates to `j-rig eval`** — it shells out to the already-shipped
  `j-rig eval <skill-dir> --json` command and maps that command's `scoreCard`
  (`pass_rate`) into a refiner-core `ScoreRecord`. No new scorer is built.
- **`propose()` wires refiner-core's `RefinerStrategy`** (`NaiveInContextStrategy`
  / `SkillOptStyleStrategy`, both from wave 1) to a model-completion seam. It
  reuses the repo's SDK-free Anthropic-Messages-API convention (an injectable
  transport, no `@anthropic-ai/sdk` dependency), the same approach the eval
  command's `RealAnthropicProvider` uses.

## Injectable boundaries (so tests need no live evaluator / SDK / disk)

Every side-effecting boundary is injected:

- `RefinerStore` takes a `FileSystem` seam → tests use an in-memory fake.
- `score()` takes an `EvalRunner` seam → tests assert it delegates + maps without
  spawning `j-rig`.
- `propose()` / `createRefinerModel()` take a `CompletionClient` → tests mock the
  model (and assert tiered routing rejects opus) without `ANTHROPIC_API_KEY`.

## CLI

```bash
j-rig refine bootstrap <skill-dir>   # synthesize a held-out eval set (offline)
j-rig refine score <skill-dir> --eval-set-file reviewed.json  # reviewed inputs + model key
j-rig refine propose <skill-dir>     # propose a bounded edit (needs ANTHROPIC_API_KEY)
j-rig refine apply <skill-dir> --proposal <hash>   # apply a stored proposal → new version (offline)
j-rig refine status <skill-id>       # show the store + event log (offline)
```

`j-rig refine score` and `j-rig refine propose` share the provider registry with
`j-rig eval`. For the funded MiniMax path, use an injected `MINIMAX_API_KEY`
and pin `MiniMax-M3` explicitly:

```bash
j-rig refine score ./my-skill --eval-set-file reviewed.json --provider minimax --model MiniMax-M3
```

The registry resolves MiniMax through `https://api.minimax.io/v1`; credentials
are runtime inputs and are never committed.

## Frozen scoring inputs

`refine score --eval-set-file ./reviewed-eval-set.json` reads a complete `EvalSet`
JSON value. `--eval-set <store-hash>` remains available for stored values; the
selectors are mutually exclusive. Every item must have a unique ID, a non-empty
prompt, and an explicit `expectation` describing the independently judged
behavior. Synthetic bootstrap emits draft prompts without expectations, so its output must
be reviewed and annotated before scoring. The adapter refuses missing
expectations before starting an evaluator or storing a score.

After reviewing a draft, set its new version/lineage fields and recompute the
existing content hash with the pure core API (preserve the old object):

```ts
import { hashValue } from "@intentsolutions/refiner-core";
const { skillId, source, items, evalSetVersion, lineageParent, refreshDueAt } = reviewed;
const frozen = {
  ...reviewed,
  hash: hashValue({ skillId, source, items, evalSetVersion, lineageParent, refreshDueAt }),
};
```

Scoring checks the document text hash, eval-set content hash, and shared skill ID.
It writes the supplied `SKILL.md` and a generated evaluation spec into a private
temporary directory, invokes the existing J-Rig evaluator, then removes the
scratch directory and its database on success or failure. The generated spec
runs each exact prompt against its own expectation with trigger tests disabled;
its criteria count must match the returned scorecard. It does not substitute the
source directory's `eval-spec.yaml` or its on-disk skill text. `SkillDoc` describes
text only: directory assets are not part of that frozen contract, and unresolved
package references fail the existing package checks rather than silently drawing
on untracked files.

A nonzero evaluator exit, stub evidence, empty/inconsistent counts, or invalid
pass rate produces no `ScoreRecord`. Historical scores and stored hashes are not
rewritten. Existing records created before this fix do not establish execution
identity retroactively; rerun the reviewed inputs before relying on them.

Items may carry `adversarial: true` inside their hashed content. For these sets,
scoring requires one evaluator verdict for each frozen criterion/case pair and
checks that the number of passing items agrees with the aggregate. The
`adversarial_pass_rate` dimension reports the passing fraction, Bernoulli
variance, and sample count over the adversarial subset. Passing means satisfying
the explicit expected behavior (for example, rejecting an injected instruction),
so higher is better. Missing adversarial items produce no dimension, not a
synthetic zero. An `unsure` verdict is not a pass.

The exported `scoreWithEvidence` adapter always requires full per-item verdicts
and returns `{ record, itemResults }` for acceptance orchestration. The existing
`score` API retains aggregate-only compatibility for non-adversarial sets.
`j-rig eval --json` exposes `criterion_results` with criterion IDs, test-case IDs,
and verdicts only; it adds no raw model output or judge explanations.

Tracked by `bd_000-projects-214c.14`, [issue #393](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/393).
Capability coverage and acceptance-quality integration remain separate work in
`bd_000-projects-214c.13`, [issue #394](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/394).

## Quality-gated proposal assessment

```bash
j-rig refine assess ./my-skill --proposal <stored-proposal-hash> \
  --eval-set-file reviewed-eval-set.json --quality-file quality.json \
  --provider minimax --model MiniMax-M3 --json
```

`quality.json` contains `evidence` and `policy`. Evidence contains:

- `evalSetHash` and the reviewed capability `manifest` (skill/hash binding,
  declared capabilities with `minimumItems`, and item-to-capability assignments).
- Nonempty `referenceItems` from the training/proposal exposure corpus, used for
  exact canonical-prompt leakage checks. This detects exact overlap, not semantic
  paraphrases or an undisclosed exposure corpus.
- `predictions`: calibration observations `{ confidence, correct }` against
  independently established labels, plus the exact calibrated
  `judge: { provider, model }`. Both scoring runs must use that judge identity.
- `verifiedEvalSet: true`, `reviewedAt`, and `expiresAt`. These record the
  caller's review assertion; the library does not authenticate a human reviewer
  or independently establish calibration-label truth.

Policy explicitly sets `maxLeakage`, `maxDuplicateRatio`, `maxBrierScore`, and
`maxEce` in `[0,1]`, plus positive integer `minCalibrationSamples` and
`minAdversarialItems`. There are no default quality thresholds. The assessment
requires complete declared capability sampling, sufficient reviewed calibration
and adversarial samples, a future eval-set refresh date, and unexpired review
evidence. Missing or unacceptable evidence blocks before evaluator calls.

The exported `assessProposal(inputs, runner, validator?)` snapshots all inputs,
applies the proposal immutably, and scores baseline and candidate afresh using
`scoreWithEvidence`. It then invokes the existing `decide` schema/statistical
gate, including non-regression on the independently measured adversarial
dimension. A different actual judge blocks the assessment; provider failures
produce no decision. Historical ScoreRecords cannot be supplied in place of
these fresh observations. The default validator uses the kernel schema.

Assessment requires 1–8 operations (the shared `MAX_OPS_PER_PROPOSAL` bound)
before evaluator I/O. Both score invocations pin `judgeProvider`/`judgeModel`
from reviewed quality evidence, overriding caller scoring options. The subprocess
forwards `--judge-provider`/`--judge-model`; Anthropic metadata reports the
resolved transport model ID. Calibration must name that concrete ID, since a
tier alias does not match the runtime identity. Ordinary scoring can still use
execution tiers. Tracked by `bd_000-projects-214c.16` /
[issue #398](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/398).

The CLI stores an immutable `acceptance-assessment` only for completed paired
evaluation, including both documents, the proposal, frozen eval set, per-item
observations, reviewed evidence, explicit policy, and their content hashes.
Blocked preconditions write no assessment. Exit status is 0 for `ACCEPT`, 2 for
blocked/rejected/schema-revision outcomes, and 1 for malformed inputs or evaluator
failure. Every outcome leaves the best pointer unchanged; promotion still
requires human action. This command does not sign an evidence bundle.

## Not in this wave (gated / later)

The SkillVersion kernel entity, the `skill-refiner-pass/v1` predicate URI + signed
evidence emission, the Claude Code plugin + 3-layer hooks, and the synchronized
npm release ceremony are all gated to later waves.

License: Apache-2.0.

## Bootstrap from retained rollouts or golden traces

Synthetic bootstrap remains the default and produces draft prompts needing
expectations. Two reviewed source paths are now available:

```bash
j-rig eval ./my-skill --spec reviewed.yaml --provider openai \
  --rollout-file rollouts.json --json
j-rig refine bootstrap ./my-skill --harvest-file rollouts.json \
  --review-file review.json --json
j-rig refine bootstrap ./my-skill --golden-file golden.json \
  --review-file golden-review.json --json
```

`--rollout-file` explicitly retains functional prompts and model output in a new
mode-0600 file. It never overwrites an existing file. The `j-rig/rollouts/v1`
export contains the skill directory ID, exact SKILL.md hash, loaded spec, overall
completion status, and per-model run IDs, providers, real-provider flags, and
observed outcomes. Failed, partial, budget-stopped, nonfunctional, and stub
exports cannot become harvested sets. Historical verdict-only output is not a
rollout source. The export is local evidence, not a signed attestation.

Golden input is human-nominated trace JSON:

```json
{
  "schema": "j-rig/golden-traces/v1",
  "skillId": "my-skill",
  "skillHash": "<bare SHA-256 of exact SKILL.md text>",
  "items": [{ "id": "gold-1", "prompt": "A request", "output": "Observed trace" }]
}
```

Both paths require a separate explicit review. Compute `sourceHash` with
`hashValue(JSON.parse(sourceText))` from `@intentsolutions/refiner-core` (canonical
JSON hashing, not a file-byte hash). Review items select a nonempty subset of
source cases and assign expected behavior independently of the observed output:

```json
{
  "schema": "j-rig/bootstrap-review/v1",
  "skillId": "my-skill",
  "skillHash": "<bare SHA-256 of exact SKILL.md text>",
  "sourceHash": "<hashValue of source JSON>",
  "reviewed": true,
  "reviewedAt": "2026-11-10T00:00:00Z",
  "items": [{ "id": "gold-1", "expectation": "The required behavior", "adversarial": true }]
}
```

For harvested cases, review IDs are `run-<runId>:<outcome.id>`. The source and
review must match the supplied skill exactly. Duplicate or unknown cases,
missing expectations, non-boolean adversarial labels, future/invalid review times, and unreviewed input fail
before storage. Review declarations are caller attestations, not authenticated
reviewer identities. Observed output is never copied into expectations.

Optional boolean `adversarial` labels come from the review and remain in hashed
items, allowing imported sets to participate in the existing assessment quality
gate. Source annotations do not override reviewed labels.

Source and review objects are retained unchanged as `bootstrap-source` store
records. The default filesystem store creates files with mode 0600 and store
directories with mode 0700, tightening existing store directories before import.
Each item carries their hashes and its source case ID; harvested items
also carry run/model identity. Provenance participates in the existing EvalSet
hash through its items. Identical inputs and clock produce identical hashes;
synthetic hash preimages remain unchanged.

Use `--eval-set-version 1.1.0 --parent-set-file prior-set.json` for a new version
that retains the parent's lineage ID and names its content hash. The parent must
have a valid schema, hash, matching skill ID, and a different version. Default
refresh is 90 days from bootstrap; `--quick` leaves it null, which prevents
quality-gated assessment until refreshed. Import does not establish held-out
independence or calibration: assessment still requires its separate quality
checks. Refs `bd_000-projects-214c.15` /
[issue #397](https://github.com/jeremylongshore/j-rig-skill-binary-eval/issues/397).

### Optimizer experiments

The existing `optimize` analysis can bind a stored one-operation edit to a
Refiner experiment. Map the weakest legacy criterion to a reviewed eval item
explicitly; the command does not infer that mapping or generate a new edit.

```bash
j-rig optimize --skill demo --db j-rig.db --run-id 42 \
  --refiner-proposal <stored-edit-hash> --skill-dir ./demo \
  --eval-set-file reviewed.json --target-item case-20 \
  --change-type instruction --expected-impact "Correct the target failure" --json
j-rig refine assess ./demo --experiment <optimizer-experiment-hash> \
  --eval-set-file reviewed.json --quality-file quality.json --provider openai --json
```

Both commands use `loadSkillDoc` to derive the skill ID from the resolved directory
basename, including when invoked with `.`.

All six bridge options are required together. Without them, `optimize` retains
its analysis-only behavior. The selected source run must be completed and belong
to the requested skill, with its legacy 16-character digest matching the current
baseline. That truncated historical digest is not a full Refiner identity.
The new immutable record retains the full document, run metadata and result rows;
it does not reclassify historical results as fresh scoring evidence.

`createRefinerExperiment` (pure core) binds the shared `ChangeProposal` and
`Experiment` contracts to baseline/candidate documents, a frozen EvalSet,
exactly one effective EditProposal operation, source evidence and explicit target.
`assessOptimizerExperiment` (adapter) reconstructs and checks that binding before
fresh paired scoring. Acceptance requires the normal reviewed-quality, kernel
schema and statistical gates **and** a failing-to-passing target with no
previously passing item regressing. The legacy `evaluateExperiment` refuses
Refiner-bound experiments. Ordinary Refiner assessments still allow 1–8 edits.

Completed assessments append a child experiment whose parent is the proposed
record's content address. Resolution retains assessment and paired-score hashes;
the assessment holds the full score evidence. Quality-blocked assessments produce
no child. Neither command edits SKILL.md or moves the best pointer. Raw historical
result messages are retained locally in the private Refiner store; review their
content before sharing. These local records do not authenticate the source.

Tracked by `bd_000-projects-214c.17` / GitHub #401; API doc 029 §8.8.
