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
j-rig refine score <skill-dir>       # delegate scoring to `j-rig eval` (needs a model key)
j-rig refine propose <skill-dir>     # propose a bounded edit (needs ANTHROPIC_API_KEY)
j-rig refine apply <skill-dir> --proposal <hash>   # apply a stored proposal → new version (offline)
j-rig refine status <skill-id>       # show the store + event log (offline)
```

## Not in this wave (gated / later)

The SkillVersion kernel entity, the `skill-refiner-pass/v1` predicate URI + signed
evidence emission, the Claude Code plugin + 3-layer hooks, and the synchronized
npm release ceremony are all gated to later waves.

License: Apache-2.0.
