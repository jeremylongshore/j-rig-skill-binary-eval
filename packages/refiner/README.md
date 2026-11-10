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
behavior. Bootstrap emits draft prompts without expectations, so its output must
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

## Not in this wave (gated / later)

The SkillVersion kernel entity, the `skill-refiner-pass/v1` predicate URI + signed
evidence emission, the Claude Code plugin + 3-layer hooks, and the synchronized
npm release ceremony are all gated to later waves.

License: Apache-2.0.
