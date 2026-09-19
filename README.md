# j-rig-skill-binary-eval

Part of the **[Intent Eval Platform](https://github.com/intent-solutions-io/intent-eval-platform)** — the umbrella grouping the platform's six repos: five converge via a shared Evidence Bundle schema (`intent-eval-core`, `intent-eval-lab`, `audit-harness`, `j-rig-skill-binary-eval`, `intent-rollout-gate`), plus `intent-eval-dashboard` as a satellite consumer (not part of the convergence taxonomy).

> Software-grade release discipline for Claude Skills

Binary evaluation harness that treats `SKILL.md` artifacts as production software. Package integrity, trigger precision, functional quality, regression gating, baseline comparison, model-aware testing, and evidence-backed rollout decisions — all through binary yes/no criteria with external evaluators.

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/jeremylongshore/j-rig-skill-binary-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremylongshore/j-rig-skill-binary-eval/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jeremylongshore/j-rig-skill-binary-eval)](https://github.com/jeremylongshore/j-rig-skill-binary-eval/releases)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/U5S225PTME)

**Links:** [Master Blueprint](000-docs/007-PP-PLAN-master-build-blueprint.md) · [Epic Index](000-docs/epics/README.md) · [Doc Index](000-docs/000-INDEX.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

---

## One-Pager

### The Problem

Claude Skills ship on instinct. A skill author writes a `SKILL.md`, eyeballs it, maybe runs it once, and pushes. There is no regression gate, no trigger precision measurement, no baseline comparison, no model-variance tracking, and no evidence trail for rollout decisions. When a skill breaks silently after a model update or a description tweak causes sibling confusion across a pack, nobody knows until users complain.

### The Solution

J-Rig Binary Eval is a seven-layer evaluation harness. All seven layers are implemented; a default
`eval` run wires five of them and honestly reports which layers actually scored the skill in the
evidence bundle's `coverage.dimensionsSkipped` (never a silent overclaim). The seven layers:

1. **Package Integrity** — Does it parse, validate, and reference real files? _(runs by default)_
2. **Trigger Quality** — Does it fire on the right prompts and stay silent on the wrong ones? _(runs by default, given a roster)_
3. **Functional Quality** — Does it complete its task and produce correct artifacts? _(runs by default)_
4. **Regression Protection** — Did this change break anything that previously worked? _(coded; runs when a prior-run baseline is supplied — otherwise reported as skipped)_
5. **Baseline Value** — Does the skill actually outperform the naked model? _(coded; runs on an opt-in naked-model comparison pass — otherwise reported as skipped)_
6. **Model Variance** — Does it work across Haiku, Sonnet, and Opus? _(runs per model; true cross-model variance needs distinct provider models configured)_
7. **Rollout Safety** — Any prompt leakage, overreach, or unsafe automation? _(runs by default)_

> **Coverage honesty:** all seven layers are runnable. Layers 4 and 5 are **opt-in** — enable them
> with `--regression-baseline <prior-run.json>` (regression) and `--baseline-check` (baseline, which
> doubles execution+judge cost). When they are not enabled, every run declares that in the signed
> evidence bundle's `coverage.dimensionsSkipped` — the harness never claims a layer scored a skill
> when it did not. A sacred (`regression_critical`) regression **blocks** release.

Every criterion is binary (yes/no). The evaluator is always separate from the skill under test. Observed behavior outranks claimed behavior.

### W5

|           |                                                                                  |
| --------- | -------------------------------------------------------------------------------- |
| **Who**   | Claude Skill authors, skill pack maintainers, enterprise skill library operators |
| **What**  | Evaluation harness + regression gate + optimization engine for Claude Skills     |
| **Where** | Local CLI (author workflow), CI/CD (PR gate), team dashboard (reporting)         |
| **When**  | Every skill change: new skill, description edit, body rewrite, model update      |
| **Why**   | Skills are production software — they need release-quality discipline, not vibes |

### Stack

| Layer               | Technology                                                  |
| ------------------- | ----------------------------------------------------------- |
| Runtime             | TypeScript, Node.js 20+, pnpm                               |
| CLI/Parsing         | commander, @clack/prompts, picocolors, yaml, unified/remark |
| Validation          | zod                                                         |
| LLM Integration     | @anthropic-ai/sdk                                           |
| Persistence         | better-sqlite3, drizzle-orm                                 |
| Concurrency         | p-limit, async-retry                                        |
| Artifact Extraction | pdf-parse, mammoth                                          |
| Dashboard (future)  | Next.js, Tailwind, shadcn/ui                                |

### Key Differentiators

- **Binary criteria only** — if a criterion can't be answered yes or no, it isn't ready. No fuzzy scores, no vibes.
- **External evaluators** — the skill under test never judges itself. Deterministic checks first, LLM judges second.
- **Sacred regressions** — a change that improves average score but breaks a sacred case is rejected. Period.
- **One change at a time** — the optimizer proposes exactly one atomic change per experiment. No multi-variable confusion.
- **Baseline gating** — if the base model already does the job without the skill, the skill gets flagged for obsolete review.
- **Model-aware** — Haiku, Sonnet, and Opus are tested independently. Model variance is product reality, not noise.
- **Evidence-backed rollout** — every ship/no-ship decision comes with a structured evidence trail.

---

## Operator-Grade System Analysis

### Architecture (Seven Layers)

```text
┌─────────────────────────────────────────────────┐
│                   CLI / CI / API                 │  Layer 7: Surfaces
├─────────────────────────────────────────────────┤
│                 Evidence Layer                   │  Layer 6: Persistence
├─────────────────────────────────────────────────┤
│               Optimization Layer                 │  Layer 5: Experiments
├─────────────────────────────────────────────────┤
│                Judgment Layer                    │  Layer 4: Scoring
├─────────────────────────────────────────────────┤
│              Observation Layer                   │  Layer 3: Capture
├─────────────────────────────────────────────────┤
│               Execution Layer                    │  Layer 2: Harness
├─────────────────────────────────────────────────┤
│                  Spec Layer                      │  Layer 1: Contracts
└─────────────────────────────────────────────────┘
```

| Layer            | Responsibility                                                                               | Key Entities                                 |
| ---------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Spec**         | Human-authored YAML eval contracts, criteria, test cases                                     | `eval_specs`, `criteria`, `test_cases`       |
| **Execution**    | Runs skills against trigger, functional, regression, adversarial, baseline cases             | `runs`, `skill_versions`                     |
| **Observation**  | Captures outputs, artifacts, cost, latency, timing, observed outcomes                        | `observed_outcomes`, `outputs`               |
| **Judgment**     | Deterministic checks first, external LLM judges second, calibration, disagreement handling   | `criterion_results`                          |
| **Optimization** | Failure clustering, weakest-criterion targeting, single atomic changes, accept/reject/revert | `experiments`                                |
| **Evidence**     | Stores runs, scores, artifacts, diffs, regressions, baselines, launch reports                | `regressions`, `baselines`, `launch_reports` |
| **CLI/CI/API**   | Local author workflows, PR gating, team reporting, dashboard                                 | —                                            |

### Epic Roadmap (10 Epics, Sequential)

| #   | Epic                 | Scope                                                                   |
| --- | -------------------- | ----------------------------------------------------------------------- |
| 01  | Repo Foundation      | Workspace skeleton, governance, CI                                      |
| 02  | Spec Layer           | YAML eval contracts, criteria schema, test case format                  |
| 03  | Package Integrity    | Deterministic structure/metadata validation                             |
| 04  | Evidence Layer       | SQLite persistence, run lifecycle, evidence serialization               |
| 05  | Trigger Harness      | Roster builder, trigger simulation, precision/recall                    |
| 06  | Functional Execution | Skill invocation, context injection, artifact capture                   |
| 07  | Judgment Layer       | Binary judge engine, calibration, per-model matrix                      |
| 08  | Regression/CLI/CI    | Regression comparison, baseline gating, score aggregation, CLI, PR gate |
| 09  | Optimizer            | Failure clustering, one-change proposals, experiment runner             |
| 10  | Team Product         | Dashboard, eval packs, drift reevaluation, obsolete-review              |

### Non-Negotiable Design Principles

1. **Criteria must be binary** — yes or no, no gradients
2. **Evaluator is always separate** — the skill never judges itself
3. **Observed behavior outranks claimed behavior** — grade what happened, not what the skill says it does
4. **Regression tests are sacred** — a regression on a sacred case blocks release regardless of average improvement
5. **One change at a time** — optimizer proposes exactly one atomic change per experiment
6. **Blockers block release** — a blocker failure cannot be averaged out
7. **Baseline value matters** — if the naked model matches the skill, flag for obsolete review
8. **Model-aware testing is required** — Haiku/Sonnet/Opus differences are product reality

### Reference Library (32 files)

Self-contained library of templates, reference standards, agent patterns, and workflow diagrams under [`000-docs/`](000-docs/000-INDEX.md):

| Directory                           | Contents                                                            |
| ----------------------------------- | ------------------------------------------------------------------- |
| `templates/skill-templates/`        | 6 SKILL.md structural patterns                                      |
| `templates/eval-schemas/`           | Eval JSON schemas                                                   |
| `references/skill-standards/`       | AgentSkills.io spec, source-of-truth, frontmatter, validation rules |
| `references/eval-patterns/`         | Eval methodology, workflows, output patterns                        |
| `references/agents/`                | Grader, comparator, analyzer agent patterns                         |
| `references/enterprise-standards/`  | 100-point rubric, production validator schema registry              |
| `references/drift-and-consistency/` | Drift categories, source-of-truth hierarchy                         |
| `references/epic-workflows/`        | 10 ASCII workflow diagrams (one per epic)                           |

### Current Status

**Phase:** Well beyond the initial foundation epic — the monorepo publishes four `@intentsolutions/*` packages (`jrig-cli`, `refiner`, `refiner-core`, `rollout-gate`) with the root semver line at `v2.1.0`. See the [CHANGELOG](CHANGELOG.md) and [Epic Index](000-docs/epics/README.md) for shipped scope.

pnpm monorepo with nine workspace packages — four published to npm (`@intentsolutions/{jrig-cli,refiner,refiner-core,rollout-gate}`) and five internal-only (`@j-rig/{core,dashboard,db,migrate,pr-comment}`, the eval engine plus its `migrate`/`pr-comment` helpers; the `@j-rig` scope is unpublished) — on a TypeScript baseline (tsup builds), with quality guardrails (ESLint, Prettier, Vitest) and CI/CD workflows.

### Choosing a provider

`j-rig eval` runs the trigger / functional / judgment layers against a **real model API** so the rollout decision is ground truth. It supports the real Anthropic Messages API **and** any OpenAI-Chat-Completions-compatible endpoint — DeepSeek, Kimi/Moonshot, OpenRouter, OpenAI, MiniMax, Groq, and NVIDIA — through one configurable adapter (`providers/openai-compatible.ts`). No vendor SDK is added; every call routes through the same injectable `Transport` seam, so it stays CISO-gate-clean (no key logging, no subprocess spawn).

**Switch providers with at most three env vars.** Set a per-provider key for a built-in preset, or the generic `LLM_*` triple to point at any compatible gateway:

| Provider | Key env var | Base URL (default) | Default model |
|---|---|---|---|
| **DeepSeek** | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` | `deepseek-v4-flash` (V4 Lite; or `deepseek-reasoner`) |
| **Kimi / Moonshot** | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` | `kimi-k2.6` |
| **OpenRouter** | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` or `moonshotai/kimi-k2` |
| **OpenAI** | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| **MiniMax** | `MINIMAX_API_KEY` | `https://api.minimax.io/v1` | `MiniMax-M3` |
| **Groq** | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| **NVIDIA NIM** | `NVIDIA_API_KEY` | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.3-70b-instruct` |
| **Anthropic** | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/messages` | `sonnet` / `haiku` / `opus` |
| **Generic** (any compatible) | `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` | — | — |

```bash
# DeepSeek (default OpenAI-compatible preset) — model deepseek-v4-flash
DEEPSEEK_API_KEY=sk-... node packages/cli/dist/index.js eval ./my-skill --models deepseek-v4-flash

# Kimi / Moonshot
MOONSHOT_API_KEY=sk-... node packages/cli/dist/index.js eval ./my-skill --provider kimi --models kimi-k2-0711-preview

# MiniMax M3 (funded real-provider path; keep the model pin explicit)
MINIMAX_API_KEY=sk-... node packages/cli/dist/index.js eval ./my-skill \
  --provider minimax --models MiniMax-M3 --json

# Any OpenAI-compatible gateway via the generic triple
LLM_API_KEY=sk-... LLM_BASE_URL=https://my-gateway/v1 LLM_MODEL=some-model \
  node packages/cli/dist/index.js eval ./my-skill
```

**Running a real MiniMax M3 eval (Intent Solutions internal).** The
`MINIMAX_API_KEY` is supplied from an encrypted secret store or a repository
secret — never hardcoded, never committed in plaintext. Inject it into the
process at runtime and pin the provider model explicitly:

```bash
# from the operator's secret manager / CI environment:
export MINIMAX_API_KEY='<injected at runtime; do not paste into source>'

# then, from j-rig-binary-eval/:
node packages/cli/dist/index.js eval ./path/to/skill \
  --provider minimax --models MiniMax-M3 --json
```

The unit tests never touch the network or a real key — the adapter's wire format +
normalization are exercised through an injected **stub transport** that returns canned
OpenAI Chat-Completions payloads (`providers/openai-compatible.test.ts`). The
MiniMax preset strips only a leading `<think>…</think>` block before judge parsing;
the raw credential is never logged. Only an explicitly configured runtime path
makes a real provider call.

**Model ids are overridable** (via `--models` or `LLM_MODEL`) because vendor model ids churn — pin a dated snapshot when you need reproducibility. **Auto-detection precedence** when no `--provider` flag is given: an OpenAI-compatible key (DeepSeek → Kimi → OpenRouter → OpenAI → MiniMax → Groq → NVIDIA, then generic `LLM_*`) wins first, then `ANTHROPIC_API_KEY`, then stub. A `--provider deepseek|kimi|moonshot|openrouter|openai|minimax|groq|nvidia|anthropic|stub` flag forces the choice. The chosen `provider` + `model` are recorded in `--json` output and in the OTel events.

**Provider failures sign `error`, never a grade.** If any execution or judge
call the evaluation depends on fails, `j-rig eval` records no verdict for that
model and still emits evidence: a `gate-result/v1` row with
`gate_decision: "error"`, the error class first in `gate_reasons`, and typed
credential-free `metadata.error_detail`. The run is stored `failed` and the
process exits 2. A partial outage counts: a score over the surviving criteria is
not a measurement. HTTP 402 and messages such as `Insufficient Balance` are
non-retryable quota failures; completed responses with empty text remain valid
boundary observations for tool-dependent skills. See
[`037-AT-SPEC-real-provider-failure-boundary-2026-08-02.md`](000-docs/037-AT-SPEC-real-provider-failure-boundary-2026-08-02.md).

**Where to get Kimi (K2):** the Moonshot console at [platform.moonshot.ai](https://platform.moonshot.ai) / [platform.kimi.ai](https://platform.kimi.ai) (OpenAI-compatible API), routed through [OpenRouter](https://openrouter.ai) (`moonshotai/kimi-k2`), or the open weights on [Hugging Face](https://huggingface.co/moonshotai) for self-hosting behind any OpenAI-compatible server (vLLM / SGLang).

### Generic task/config runs (active evaluation-platform evolution)

The generic substrate is now available beneath the skill-specific evaluator.
Define a task and a named model/harness configuration, then execute one
shell-free sample with an immutable raw Run record:

```bash
node packages/cli/dist/index.js run \
  --task ./task.yaml \
  --config ./config.yaml \
  --sample-index 0 \
  --db ./j-rig.db \
  --json
```

The runner captures stdout, stderr, exit status, timeout, timing, request
lineage, and content-addressed artifact references before any future Grader is
allowed to evaluate the output. Repeating the same task/config/model/sample
returns the existing sealed Run instead of duplicating it. The contract is
documented in [`031-AT-SPEC-generic-runner-config-raw-run-2026-08-01.md`](000-docs/031-AT-SPEC-generic-runner-config-raw-run-2026-08-01.md).

### Named Graders and regrade

Completed raw Runs can be evaluated with a named, versioned deterministic
Grader. Each Grade stores the exact definition snapshot and digest, so repeated
grading is idempotent and a later version can coexist with the earlier result:

```bash
node packages/cli/dist/index.js grade \
  --run-id raw_<sha256> \
  --grader ./grader.yaml \
  --db ./j-rig.db \
  --json
```

Use `--regrade` when intentionally applying a different version of the same
named Grader. Runner errors and timeouts remain ungraded observations. See
[`032-AT-SPEC-named-graders-snapshots-regrade-2026-08-01.md`](000-docs/032-AT-SPEC-named-graders-snapshots-regrade-2026-08-01.md).

### Balanced execution sampling

The generic substrate can plan resumable, balanced top-ups for each complete
Task × Config × Model cell. Completed Runs count toward target N, active Runs
reserve a slot, and runner failures/timeouts are retained but replaced by a
fresh sample index:

```bash
node packages/cli/dist/index.js sample-plan \
  --manifest ./sampling-manifest.yaml \
  --target-n 3 \
  --db ./j-rig.db \
  --json
```

The plan is inspectable JSON. Measurements select one exact Grader snapshot
and expose pass rate, harness failures, ungraded completions, Wilson intervals,
score standard error, and model-judge vote disagreement without heterogeneous
rollups. Use `j-rig report --sampling-manifest` with the full Grader identity
to render them. `j-rig suite` plans and executes these same jobs as one
resumable command (below). See
[`033-AT-SPEC-balanced-sampling-uncertainty-2026-08-01.md`](000-docs/033-AT-SPEC-balanced-sampling-uncertainty-2026-08-01.md).

`j-rig batch` consumes a path-based suite manifest, executes these jobs in
balanced passes, and resumes from the immutable raw-run ledger. Runner
failures remain diagnostic observations rather than model grades:

```bash
node packages/cli/dist/index.js batch \
  --manifest ./batch.yaml \
  --db ./j-rig.db \
  --json
```

### Unified report

The new report projection selects one immutable Grader snapshot and preserves
per-cell Task × Config × Model metrics plus raw Run lineage:

```bash
node packages/cli/dist/index.js report \
  --unified \
  --db ./j-rig.db \
  --grader-id answer-checker \
  --grader-version 1.0.0 \
  --grader-snapshot-sha256 sha256:<64 lowercase hex> \
  --json \
  --output ./report.json
```

Use `--html --output ./report.html` for a self-contained accessible HTML
projection with inline CSS and no scripts, external assets, or network fetches.
Omit `--json` and `--html` for Markdown. Empty data is rendered explicitly; no
global pass rate is inferred across heterogeneous cells. These are local
unsigned projections. The verified dashboard adapter and any Evidence
Bundle/signing path remain downstream. See
[`034-AT-SPEC-unified-report-json-markdown-2026-08-01.md`](000-docs/034-AT-SPEC-unified-report-json-markdown-2026-08-01.md)
and [`038-AT-SPEC-unified-report-html-static-2026-08-02.md`](000-docs/038-AT-SPEC-unified-report-html-static-2026-08-02.md).

### Skills-root batch dogfood

The skills-specific batch surface composes the existing scaffold and evaluator
so a library can be exercised with one documented command:

```bash
MINIMAX_API_KEY=sk-... \
  node packages/cli/dist/index.js eval-batch ~/.claude/skills \
  --provider minimax \
  --models MiniMax-M3 \
  --db ./j-rig.db \
  --batch-id skills-2026-08-01 \
  --json
```

Existing `eval-spec.yaml` files are reused. Missing specs are generated as
validated trigger/safety baselines under `.j-rig/eval-batches/<batch-id>/`;
they do not claim deep skill-specific functional quality. Each child writes a
separate kernel-valid Evidence Bundle and links its digest into the shared
SQLite store. The versioned batch manifest retains source/spec provenance,
relative skill lineage, model/provider summaries, and failures. Use
`--write-specs` only when you intentionally want generated specs copied beside
source skills. Each batch also writes `report.json`, `report.md`, and a
self-contained `report.html` beside `manifest.json`; these preserve per-skill
lineage and failures without inventing an overall quality score or rollout
decision. See
[`035-AT-SPEC-eval-batch-skills-root-2026-08-01.md`](000-docs/035-AT-SPEC-eval-batch-skills-root-2026-08-01.md)
and [`039-AT-SPEC-eval-batch-report-projection-2026-08-02.md`](000-docs/039-AT-SPEC-eval-batch-report-projection-2026-08-02.md).

### Generic suite lifecycle

`j-rig suite` is the one-command lifecycle for arbitrary evaluation
directories. A suite manifest names two or more Task YAML files, named Config
YAML files, one deterministic Grader, and a positive `target_n`:

```yaml
schema: j-rig/eval-suite/v1
id: answer-suite
version: "1"
tasks:
  - tasks/task-a.yaml
  - tasks/task-b.yaml
configs:
  - configs/model-a.yaml
  - configs/model-b.yaml
grader: graders/answer.yaml
target_n: 3
```

Run it with one command:

```bash
node packages/cli/dist/index.js suite ./suite.yaml \
  --db ./j-rig.db \
  --output-dir ./.j-rig/suites/answer-suite \
  --json
```

Paths resolve relative to `suite.yaml`. The command expands a deterministic
Task × Config × Model matrix, persists every raw Run before grading, grades
only completed observations, and writes an atomic audit manifest plus
suite-scoped JSON, Markdown, and self-contained HTML reports. Repeating the
command reuses sealed raw Runs and adds only missing sample indices; runner
failures remain visible and ungraded until a later top-up succeeds. The audit
and report carry the suite id, manifest path, cell definitions, raw Run ids,
immutable Grader selector, and report paths. The HTML projection is local and
unsigned.

The existing skill-specific `eval` and `eval-batch` commands remain supported.
Use `j-rig migrate <dir>` for legacy v0.1.0-draft Evidence Bundle fixtures;
generic suite manifests do not rewrite old evidence implicitly. See
[`036-AT-SPEC-eval-suite-lifecycle-2026-08-01.md`](000-docs/036-AT-SPEC-eval-suite-lifecycle-2026-08-01.md)
and [`MIGRATION.md`](MIGRATION.md).

### ⚠️ Stub providers — output is NOT ground truth

When **no** real provider key is present, `j-rig eval` falls back to stub providers that emit synthetic outputs, and the CLI **refuses to run** unless you explicitly opt in by setting `J_RIG_ALLOW_STUB=1`. When stub mode is active, a loud banner is emitted to stderr on every invocation. Do not consume stub-mode output as evidence of skill quality; CI gates that ingest j-rig artifacts must refuse rows produced under stub mode.

Full discipline: [STUB-PROVIDERS.md](./STUB-PROVIDERS.md).

---

## Skill scoring — adoption signal + intake verbs

The skill-scoring gap-fill layer (epic [intent-eval-lab#206](https://github.com/jeremylongshore/intent-eval-lab/issues/206), ratified by ISEDC DR-103) adds a **deterministic, time-decayed adoption signal** and the **intake verbs** that feed it. It answers a question the static rubric and the behavioral eval cannot: _is this skill still earning its keep versus the bare model, in the real world?_ It consumes the kernel `usage_events` + `human_reviews` entities (`@intentsolutions/core@0.10.0`).

### Intake — `j-rig ingest-skill` and `j-rig review`

```bash
# Record one CASS-gated usage event (anti-gaming — verified sessions only, never raw loads)
node packages/cli/dist/index.js ingest-skill my-skill \
  --session-id sess-123 --source ci \
  --tests-passed --clear-resolution --code-changes

# Record a curated-signal human thumb + open-ended rationale
node packages/cli/dist/index.js review my-skill --verdict up \
  --rationale "saved a manual step" --reviewer jeremy@intentsolutions.io
```

- **CASS anti-gaming gate (≥0.30).** A usage row is scored on session quality
  (`tests-passed +0.25`, `clear-resolution +0.25`, `code-changes +0.15`,
  `user-confirmed +0.15`, `backtracking −0.10`, `abandoned −0.20`). A failing row is
  **persisted but excluded** from every adoption rollup — load-in-a-loop to inflate
  adoption is _visible_ in the data, never silently counted. There is no force-count flag.
- **Source split.** `--source ci` (gate-anchored, trusted) vs `--source plugin`
  (unverified). The adoption signal weights unverified loads at/near zero.
- **`j-rig review` is a curated signal, not a trust root.** It is explicitly **not** the
  signed in-toto `human-review/v1` predicate; rows carry `governance_class: "curated-signal"`.
- Both write **local SQLite** fact tables (`@j-rig/db`); no OTel events are minted (the
  OTel name set is closed/normative). The `tenant_id` column is reserved in the first
  `CREATE TABLE`; an absent tenant is a first-class global bucket, never pooled cross-tenant.

### Adoption verdict — the deterministic 2×2 (`@intentsolutions/refiner-core`)

`computeAdoptionVerdict()` joins the existing **baseline-value flag** (does the bare model
match the skill?) with a **time-decayed adoption rate** into one advisory verdict:

| bare model matches? | users keep it? | verdict |
|---|---|---|
| skill adds value | high adoption | `keep` |
| skill adds value | low adoption | `watch` (discoverability problem) |
| bare model matches | high adoption | `deprecate_review` (model caught up but used) |
| bare model matches | low adoption | `obsolete_review` (both axes agree) |

The two axes are **AND-combined, never averaged** — there is no rolled "usefulness %" (C3).
Each event's weight decays exponentially with age (`weight = 0.5 ** (ageDays / halfLifeDays)`),
so a skill that rots as base models improve loses signal. The mechanism is a deterministic
decay-with-thresholds — **the Thompson-sampling bandit is rejected** (DR-103 D5): a bandit is
non-deterministic by construction, which would break the Evidence-Bundle audit-reproducibility
contract and could route a fail-closed gate to the inferior skill version. Adoption is
**advisory-and-deprecate-only**: it never promotes a skill and never overrides the
deterministic `accept()` / `decideRollout()` gate, which stays the shipping authority. It rides
the additive opt-in `LaunchReport.adoptionVerdict?` field — the `RolloutDecision` union is
**not** mutated. Thresholds ship **explicitly provisional** (`thresholdsProvisional: true`) until
back-tested against a real soak window; `buildLaunchReport` takes an **injected clock** so the
artifact the signal lands in is replayable.

---

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.

**Note:** versions `0.x` shipped under the MIT license. Starting with `v1.0.0`, the project is licensed under Apache 2.0. Any existing `0.x` artifacts remain available under their original MIT terms; new releases (`>= 1.0.0`) are Apache 2.0.

## Author

**Jeremy Longshore** — [jeremylongshore](https://github.com/jeremylongshore) · Intent Solutions
